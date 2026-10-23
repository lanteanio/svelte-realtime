// Build-time inventory only; runtime messages are never changed by this scanner.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'acorn';
import { REALTIME_ERROR_IDS, REALTIME_ERROR_REGISTRY } from '../src/error-registry.js';

const root = resolve(import.meta.dirname, '..');
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const registry = new Map(REALTIME_ERROR_REGISTRY.map(entry => [entry.id, entry]));
const FUNCTION_TYPES = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);
// How a structured event leaves the process: through the installed sink, or
// printed straight to the console in the shared line format.
const DELIVERY = Object.freeze({ emitOperationalEvent: 'operational event sink', formatDiagnostic: 'console only (bypasses the operational event sink)' });
export const INFORMATIONAL_SEVERITIES = Object.freeze(['debug', 'info', 'trace']);

export function runtimeSources(directory = 'src') {
	return readdirSync(resolve(root, directory), { withFileTypes: true }).flatMap(entry => {
		const path = directory + '/' + entry.name;
		return entry.isDirectory() ? runtimeSources(path)
			: entry.name.endsWith('.js') && path !== 'src/error-registry.js' ? [{ path, source: readFileSync(resolve(root, path), 'utf8') }] : [];
	}).sort((a, b) => compare(a.path, b.path));
}
function walk(node, visit, parents = []) {
	if (!node || typeof node !== 'object') return;
	visit(node, parents);
	for (const child of Object.values(node)) {
		if (Array.isArray(child)) for (const value of child) walk(value, visit, [...parents, node]);
		else if (child && typeof child.type === 'string') walk(child, visit, [...parents, node]);
	}
}
function definition(node) {
	const key = node?.arguments?.[0];
	return key?.type === 'MemberExpression' && key.object?.name === 'REALTIME_ERROR_IDS'
		? registry.get(REALTIME_ERROR_IDS[key.property?.name]) : undefined;
}
const isFallback = node => node?.type === 'LogicalExpression' && (node.operator === '||' || node.operator === '??');
function literals(node) {
	if (node?.type === 'Literal' && typeof node.value === 'string') return [node.value];
	if (node?.type === 'ConditionalExpression') return [...literals(node.consequent), ...literals(node.alternate)];
	if (isFallback(node)) return [...literals(node.left), ...literals(node.right)];
	if (node?.type === 'CallExpression' && node.callee?.name === 'realtimeErrorCode') return [definition(node)?.code].filter(Boolean);
	return [];
}
function hasText(node) {
	if (node?.type === 'Literal' && typeof node.value === 'string') return true;
	if (node?.type === 'TemplateLiteral') return true;
	return node?.type === 'BinaryExpression' && node.operator === '+' && (hasText(node.left) || hasText(node.right));
}
function hole(node) {
	if (node?.type === 'Identifier') return '<' + node.name + '>';
	if (node?.type === 'MemberExpression' && !node.computed && node.property.type === 'Identifier') return '<' + node.property.name + '>';
	return '<value>';
}
// A message as literal text with a named placeholder for every computed part.
function parts(node) {
	if (node?.type === 'Literal' && (typeof node.value === 'string' || typeof node.value === 'number')) return [{ text: String(node.value) }];
	if (node?.type === 'TemplateLiteral') {
		return node.quasis.flatMap((quasi, index) => [
			{ text: quasi.value.cooked ?? '' },
			...(index < node.expressions.length ? parts(node.expressions[index]) : [])
		]);
	}
	if (node?.type === 'BinaryExpression' && node.operator === '+' && hasText(node)) return [...parts(node.left), ...parts(node.right)];
	return [{ hole: hole(node) }];
}
function render(segments) {
	let out = '', previousHole = false;
	for (const segment of segments) {
		if (segment.hole !== undefined) {
			if (!previousHole) out += segment.hole;
			previousHole = true;
		} else if (segment.text) {
			out += segment.text;
			previousHole = false;
		}
	}
	return out;
}
function patterns(node) {
	if (node?.type === 'ConditionalExpression') return [...patterns(node.consequent), ...patterns(node.alternate)];
	if (isFallback(node)) return [...patterns(node.left), ...patterns(node.right)];
	if (node?.type === 'CallExpression' && node.callee?.name === 'realtimeErrorMessage') return [definition(node)?.messagePrefix].filter(Boolean);
	if (!hasText(node)) return [];
	const segments = parts(node);
	return segments.some(segment => segment.text) ? [render(segments)] : [];
}
function complete(node, message = false) {
	if (node?.type === 'ConditionalExpression' || isFallback(node)) {
		const [a, b] = node.type === 'ConditionalExpression' ? [node.consequent, node.alternate] : [node.left, node.right];
		return complete(a, message) && complete(b, message);
	}
	if (node?.type === 'CallExpression' && node.callee?.name === (message ? 'realtimeErrorMessage' : 'realtimeErrorCode')) return Boolean(definition(node));
	if (message) return patterns(node).length > 0;
	return node?.type === 'Literal' && typeof node.value === 'string';
}
function properties(node) {
	return Object.fromEntries(node.properties.filter(property => property.type === 'Property' && !property.computed)
		.map(property => [property.key.name ?? property.key.value, property.value]));
}
// Resolve lexical bindings conservatively; unknown arguments remain dynamic.
function binds(pattern, name) {
	if (!pattern) return false;
	if (pattern.type === 'Identifier') return pattern.name === name;
	if (pattern.type === 'AssignmentPattern') return binds(pattern.left, name);
	if (pattern.type === 'RestElement') return binds(pattern.argument, name);
	if (pattern.type === 'ArrayPattern') return pattern.elements.some(item => binds(item, name));
	if (pattern.type === 'ObjectPattern') return pattern.properties.some(item => binds(item.type === 'RestElement' ? item.argument : item.value, name));
	return false;
}
function binding(name, parents) {
	for (const scope of [...parents].reverse()) {
		if (FUNCTION_TYPES.has(scope.type)) {
			const index = scope.params.findIndex(param => binds(param, name));
			if (index >= 0) return (scope.params[index].type === 'Identifier' || (scope.params[index].type === 'AssignmentPattern' && scope.params[index].left.type === 'Identifier')) ? { scope, index, parameter: scope.params[index] } : {};
			if (scope.id?.name === name) return { declaration: scope };
		}
		if (scope.type === 'CatchClause' && binds(scope.param, name)) return {};
		if (scope.type !== 'BlockStatement' && scope.type !== 'Program') continue;
		for (const statement of scope.body) {
			if (statement.type === 'FunctionDeclaration' && statement.id?.name === name) return { declaration: statement };
			if (statement.type !== 'VariableDeclaration') continue;
			const declaration = statement.declarations.find(item => binds(item.id, name));
			if (declaration) return { declaration, kind: statement.kind };
		}
	}
}
function localValues(node, parents, ast) {
	if (node?.type !== 'Identifier') return literals(node);
	const found = binding(node.name, parents);
	if (!found?.parameter || found.scope.type !== 'FunctionDeclaration' || !ast.body.includes(found.scope)) return [];
	const values = literals(found.parameter.right);
	walk(ast, (call, callParents) => {
		if (call.type !== 'CallExpression' || call.callee.type !== 'Identifier') return;
		if (binding(call.callee.name, callParents)?.declaration === found.scope) values.push(...literals(call.arguments[found.index]));
	});
	return values;
}
function assignedErrorMessage(node, parents) {
	const found = binding(node.left.object?.name, parents);
	const declaration = found?.declaration;
	return found?.kind === 'const' && declaration.start < node.start && declaration.init?.type === 'NewExpression' && declaration.init.callee.name === 'Error' ? declaration.init.arguments[0] : undefined;
}
function functionName(node, parent) {
	if (node.id?.name) return node.id.name;
	if (parent?.type === 'VariableDeclarator' && parent.id.type === 'Identifier') return parent.id.name;
	if (['Property', 'MethodDefinition', 'PropertyDefinition'].includes(parent?.type) && !parent.computed) return parent.key.name ?? String(parent.key.value);
	if (parent?.type === 'AssignmentExpression' && parent.left.type === 'Identifier') return parent.left.name;
	if (parent?.type === 'AssignmentExpression' && parent.left.type === 'MemberExpression' && !parent.left.computed) return parent.left.property.name;
	return null;
}
// The nearest named enclosing function. Anonymous callbacks report their named
// owner, so a site key survives edits elsewhere in the file.
function enclosingName(parents) {
	for (let index = parents.length - 1; index >= 0; index--) {
		if (!FUNCTION_TYPES.has(parents[index].type)) continue;
		const name = functionName(parents[index], parents[index - 1]);
		if (name) return name + '()';
	}
	return 'module scope';
}
// Pair the branches of an event conditional with a severity conditional on the
// same test, so `ok ? 'x.done' : 'x.failed'` keeps each event's own severity.
function eventSeverities(event, severity, source) {
	const text = node => source.slice(node.start, node.end);
	if (event?.type === 'ConditionalExpression' && severity?.type === 'ConditionalExpression' && text(event.test) === text(severity.test)) {
		return [...eventSeverities(event.consequent, severity.consequent, source), ...eventSeverities(event.alternate, severity.alternate, source)];
	}
	const severities = complete(severity) ? literals(severity) : [];
	return literals(event).map(name => [name, severities]);
}
// Give each code only the messages it can be thrown with: branches of a code
// conditional pair with a message conditional on the same test, and a message
// chosen by `code === 'X'` belongs to X on one side and the other codes on the other.
function codeMessages(codeNode, codes, message, source) {
	const text = node => source.slice(node.start, node.end);
	if (codeNode?.type === 'ConditionalExpression' && message?.type === 'ConditionalExpression' && text(codeNode.test) === text(message.test)) {
		return [
			...codeMessages(codeNode.consequent, literals(codeNode.consequent), message.consequent, source),
			...codeMessages(codeNode.alternate, literals(codeNode.alternate), message.alternate, source)
		];
	}
	const test = message?.type === 'ConditionalExpression' ? message.test : undefined;
	if (codeNode?.type === 'Identifier' && test?.type === 'BinaryExpression' && ['===', '!=='].includes(test.operator) &&
		test.left.type === 'Identifier' && test.left.name === codeNode.name && test.right.type === 'Literal' && codes.includes(test.right.value)) {
		const [match, rest] = test.operator === '===' ? [message.consequent, message.alternate] : [message.alternate, message.consequent];
		return [[[test.right.value], patterns(match)], [codes.filter(code => code !== test.right.value), patterns(rest)]];
	}
	return [[codes, patterns(message)]];
}
const sorted = values => [...new Set(values)].sort(compare);
const anchor = (kind, key) => kind === 'diagnostic' ? kind + '-' + encodeURIComponent(key)
	: kind + '-' + key.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/**
 * Literal coverage of emitted codes, events and console lines. Sites whose
 * code, event or message is computed are recorded by file, enclosing function
 * and emitter kind, never by line, so unrelated edits leave them unchanged.
 */
export function scanRuntimeErrors(files = runtimeSources()) {
	const errors = new Map(), diagnostics = new Map(), dynamic = new Map();
	function record(map, key, messages, path, extra = {}) {
		let row = map.get(key);
		if (!row) { row = { key, prefixes: new Set(), sources: new Set(), ...extra }; map.set(key, row); }
		for (const text of messages) row.prefixes.add(text);
		row.sources.add(path);
		return row;
	}
	for (const { path, source } of files) {
		const ast = parse(source, { sourceType: 'module', ecmaVersion: 'latest' });
		walk(ast, (node, parents) => {
			const site = kind => {
				const scope = enclosingName(parents);
				const key = path + '\0' + scope + '\0' + kind;
				const row = dynamic.get(key) ?? { path, scope, kind, count: 0 };
				row.count++;
				dynamic.set(key, row);
			};
			if (node.type === 'NewExpression' && ['LiveError', 'RpcError'].includes(node.callee?.name)) {
				const codes = localValues(node.arguments[0], parents, ast);
				if (!complete(node.arguments[0]) || (node.arguments.length > 1 && !complete(node.arguments[1], true))) site('new ' + node.callee.name);
				if (node.arguments.length < 2) for (const code of codes) record(errors, code, [code], path);
				else for (const [owned, message] of codeMessages(node.arguments[0], codes, node.arguments[1], source)) {
					for (const code of owned) record(errors, code, message, path);
				}
			}
			if (node.type === 'AssignmentExpression' && node.operator === '=' && node.left.type === 'MemberExpression' && !node.left.computed && node.left.property.name === 'code') {
				const message = assignedErrorMessage(node, parents);
				if (message) {
					const codes = literals(node.right);
					for (const code of codes) record(errors, code, patterns(message), path);
					if (!complete(node.right) || !complete(message, true)) site('Error.code');
				}
			}
			if (node.type === 'ObjectExpression') {
				const fields = properties(node);
				if (fields.ok?.value === false && fields.code && fields.error) {
					const codes = literals(fields.code), message = patterns(fields.error);
					if (!complete(fields.code) || !complete(fields.error, true)) site('error reply');
					for (const code of codes) record(errors, code, message, path);
				}
				if (fields.event && fields.component && (fields.severity || fields.level)) {
					const message = patterns(fields.message);
					if (!complete(fields.event) || !complete(fields.message, true)) site('structured event');
					for (const [event, severities] of eventSeverities(fields.event, fields.severity || fields.level, source)) {
						const row = record(diagnostics, event, message, path, { kind: 'structured event', severities: new Set(), delivery: new Set() });
						const callee = parents.at(-1)?.type === 'CallExpression' ? parents.at(-1).callee?.name : undefined;
						if (callee && Object.hasOwn(DELIVERY, callee)) row.delivery.add(DELIVERY[callee]);
						// An unresolved severity counts as a failure, never as informational.
						for (const severity of severities.length ? severities : ['unresolved']) row.severities.add(severity);
					}
				}
			}
			if (node.type === 'CallExpression' && node.callee?.type === 'MemberExpression' &&
				node.callee.object?.name === 'console' && ['warn', 'error'].includes(node.callee.property?.name)) {
				const message = patterns(node.arguments[0]);
				// Structured diagnostics are indexed by the object carrying their event.
				if (!message.length) {
					if (node.arguments[0]?.arguments?.[0]?.type !== 'ObjectExpression') site('console.' + node.callee.property.name);
					return;
				}
				if (!complete(node.arguments[0], true)) site('console.' + node.callee.property.name);
				for (const text of message) {
					const id = 'console-' + createHash('sha256').update(text).digest('hex').slice(0, 16);
					record(diagnostics, id, [text], path, { kind: 'console line' });
				}
			}
		});
	}
	const finish = (map, kind) => [...map.values()].sort((a, b) => compare(a.key, b.key)).map(row => ({
		...row, anchor: anchor(kind, row.key), prefixes: sorted(row.prefixes), sources: sorted(row.sources),
		...(row.severities ? { severities: sorted(row.severities), delivery: sorted(row.delivery) } : {})
	}));
	const dynamicSites = [...dynamic.values()].sort((a, b) => compare(a.path, b.path) || compare(a.scope, b.scope) || compare(a.kind, b.kind));
	return { errors: finish(errors, 'live-error'), diagnostics: finish(diagnostics, 'diagnostic'), dynamicSites };
}

/** True when every severity an event is emitted at reports normal operation. */
export function isInformational(row) {
	return row.kind === 'structured event' && row.severities.length > 0 && row.severities.every(severity => INFORMATIONAL_SEVERITIES.includes(severity));
}
