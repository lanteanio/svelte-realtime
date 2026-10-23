// Build-time inventory only; runtime messages are never changed by this scanner.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { posix, resolve } from 'node:path';
import { parse } from 'acorn';
import { REALTIME_ERROR_IDS, REALTIME_ERROR_REGISTRY } from '../src/error-registry.js';

const root = resolve(import.meta.dirname, '..');
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const registry = new Map(REALTIME_ERROR_REGISTRY.map(entry => [entry.id, entry]));
const FUNCTION_TYPES = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);
// How a structured event leaves the process: through the installed sink, or
// printed straight to the console in the shared line format.
const CONSOLE_ONLY = 'console only (never sent to the operational event sink)';
const DELIVERY = Object.freeze({ emitOperationalEvent: 'operational event sink', formatDiagnostic: CONSOLE_ONLY, defaultOperationalEventSink: CONSOLE_ONLY });
// Helper arguments are followed through at most this many call levels.
const MAX_HELPER_DEPTH = 4;
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

// Module-level `const NAME = <string or number literal>` of the file whose
// nodes are being read. Their values are inlined into codes and messages.
let constants = new Map();
function inUnit(unit, read) {
	const previous = constants;
	constants = unit.constants;
	try { return read(); } finally { constants = previous; }
}
const constantOf = node => node?.type === 'Identifier' ? constants.get(node.name) : undefined;
const isString = node => (node?.type === 'Literal' && typeof node.value === 'string') || typeof constantOf(node) === 'string';
const stringOf = node => node.type === 'Literal' ? node.value : constantOf(node);

const isFallback = node => node?.type === 'LogicalExpression' && (node.operator === '||' || node.operator === '??');
function literals(node) {
	if (isString(node)) return [stringOf(node)];
	if (node?.type === 'ConditionalExpression') return [...literals(node.consequent), ...literals(node.alternate)];
	if (isFallback(node)) return [...literals(node.left), ...literals(node.right)];
	if (node?.type === 'CallExpression' && node.callee?.name === 'realtimeErrorCode') return [definition(node)?.code].filter(Boolean);
	return [];
}
function hasText(node) {
	if (isString(node) || node?.type === 'TemplateLiteral') return true;
	if (node?.type === 'ConditionalExpression') return hasText(node.consequent) || hasText(node.alternate);
	return node?.type === 'BinaryExpression' && node.operator === '+' && (hasText(node.left) || hasText(node.right));
}
// Internal names say nothing to a reader of the log line, so they become a
// neutral placeholder: a leading underscore or SCREAMING_CASE anywhere, and a
// camelCase property of an internal object.
const internal = name => /^_|^[A-Z0-9_]+$/.test(name);
function hole(node) {
	if (node?.type === 'Identifier') return internal(node.name) ? '<value>' : '<' + node.name + '>';
	if (node?.type === 'MemberExpression' && !node.computed && node.property.type === 'Identifier') {
		const name = node.property.name;
		return internal(name) || /[A-Z]/.test(name) ? '<value>' : '<' + name + '>';
	}
	return '<value>';
}
// One message can print several texts: a conditional with literal text inside
// a template or a `+` chain yields one pattern per branch, so each phrase is
// searchable and rewording one branch changes its pattern. Past this many
// variants the remaining conditionals collapse into placeholders.
const MAX_VARIANTS = 16;
const product = (left, right) => left.length * right.length > MAX_VARIANTS ? undefined : left.flatMap(a => right.map(b => [...a, ...b]));
function variants(node) {
	if (node?.type === 'Literal' && (typeof node.value === 'string' || typeof node.value === 'number')) return [[{ text: String(node.value) }]];
	if (constantOf(node) !== undefined) return [[{ text: String(constantOf(node)) }]];
	if (node?.type === 'TemplateLiteral') {
		let out = [[]];
		node.quasis.forEach((quasi, index) => {
			out = product(out, [[{ text: quasi.value.cooked ?? '' }]]);
			if (index < node.expressions.length) out = product(out, variants(node.expressions[index])) ?? product(out, [[{ hole: '<value>' }]]);
		});
		return out;
	}
	if (node?.type === 'BinaryExpression' && node.operator === '+' && hasText(node)) {
		return product(variants(node.left), variants(node.right)) ?? [[{ hole: '<value>' }]];
	}
	if (node?.type === 'ConditionalExpression' && hasText(node)) return [...variants(node.consequent), ...variants(node.alternate)];
	return [[{ hole: hole(node) }]];
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
	return [...new Set(variants(node).filter(segments => segments.some(segment => segment.text)).map(render))];
}
function complete(node, message = false) {
	if (node?.type === 'ConditionalExpression' || isFallback(node)) {
		const [a, b] = node.type === 'ConditionalExpression' ? [node.consequent, node.alternate] : [node.left, node.right];
		return complete(a, message) && complete(b, message);
	}
	if (node?.type === 'CallExpression' && node.callee?.name === (message ? 'realtimeErrorMessage' : 'realtimeErrorCode')) return Boolean(definition(node));
	if (message) return patterns(node).length > 0;
	return isString(node);
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
	for (let level = parents.length - 1; level >= 0; level--) {
		const scope = parents[level];
		if (FUNCTION_TYPES.has(scope.type)) {
			const index = scope.params.findIndex(param => binds(param, name));
			if (index >= 0) return (scope.params[index].type === 'Identifier' || (scope.params[index].type === 'AssignmentPattern' && scope.params[index].left.type === 'Identifier')) ? { scope, index, parameter: scope.params[index], owner: parents[level - 1] } : {};
			if (scope.id?.name === name) return { declaration: scope };
		}
		if (scope.type === 'CatchClause' && binds(scope.param, name)) return {};
		if (scope.type !== 'BlockStatement' && scope.type !== 'Program') continue;
		for (const item of scope.body) {
			if (item.type === 'ImportDeclaration') {
				const specifier = item.specifiers.find(entry => entry.local.name === name);
				if (specifier) return specifier.type === 'ImportSpecifier' ? { imported: specifier.imported.name, from: item.source.value } : {};
				continue;
			}
			const statement = item.type === 'ExportNamedDeclaration' && item.declaration ? item.declaration : item;
			if (statement.type === 'FunctionDeclaration' && statement.id?.name === name) return { declaration: statement };
			if (statement.type !== 'VariableDeclaration') continue;
			const declaration = statement.declarations.find(entry => binds(entry.id, name));
			if (declaration) return { declaration, kind: statement.kind };
		}
	}
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
const RESOLVABLE_INIT = new Set(['Literal', 'TemplateLiteral', 'ConditionalExpression', 'LogicalExpression', 'BinaryExpression', 'Identifier']);

function consoleMethod(node, unit) {
	if (node.type !== 'CallExpression') return undefined;
	const callee = node.callee;
	if (callee?.type === 'MemberExpression' && !callee.computed && callee.object?.name === 'console' && ['warn', 'error'].includes(callee.property?.name)) return 'console.' + callee.property.name;
	if (callee?.type === 'Identifier' && unit.consoleAliases.has(callee.name)) return 'console.' + unit.consoleAliases.get(callee.name);
	return undefined;
}
function prepare({ path, source }) {
	const ast = parse(source, { sourceType: 'module', ecmaVersion: 'latest' });
	const unit = { path, source, ast, constants: new Map(), calls: [], methodCalls: [] };
	for (const item of ast.body) {
		const statement = item.type === 'ExportNamedDeclaration' && item.declaration ? item.declaration : item;
		if (statement.type !== 'VariableDeclaration' || statement.kind !== 'const') continue;
		for (const declaration of statement.declarations) {
			const init = declaration.init;
			if (declaration.id.type === 'Identifier' && init?.type === 'Literal' && ['string', 'number'].includes(typeof init.value)) unit.constants.set(declaration.id.name, init.value);
		}
	}
	// Console printers bound to a local name: `const warn = console.warn`,
	// `console.error.bind(console)` and `const { warn } = console`. Matched by
	// name across the file, so a false positive is possible, a missed alias is not.
	unit.consoleAliases = new Map();
	const printer = node => {
		const target = node?.type === 'CallExpression' && node.callee.type === 'MemberExpression' && node.callee.property.name === 'bind' ? node.callee.object : node;
		return target?.type === 'MemberExpression' && !target.computed && target.object.type === 'Identifier' && target.object.name === 'console' &&
			['warn', 'error'].includes(target.property.name) ? target.property.name : undefined;
	};
	walk(ast, (node) => {
		const bind = (id, init) => {
			if (id?.type === 'Identifier' && printer(init)) unit.consoleAliases.set(id.name, printer(init));
			if (id?.type === 'ObjectPattern' && init?.type === 'Identifier' && init.name === 'console') {
				for (const property of id.properties) {
					const key = property.type === 'Property' && !property.computed ? property.key.name : undefined;
					const value = property.value?.type === 'AssignmentPattern' ? property.value.left : property.value;
					if (['warn', 'error'].includes(key) && value?.type === 'Identifier') unit.consoleAliases.set(value.name, key);
				}
			}
		};
		if (node.type === 'VariableDeclarator') bind(node.id, node.init);
		if (node.type === 'AssignmentExpression' && node.operator === '=') bind(node.left, node.right);
		if (node.type === 'AssignmentPattern') bind(node.left, node.right);
	});
	walk(ast, (node, parents) => {
		if (node.type === 'CallExpression' && node.callee.type === 'Identifier') unit.calls.push({ call: node, parents });
		if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression' && !node.callee.computed && node.callee.property.type === 'Identifier') unit.methodCalls.push({ call: node, parents });
	});
	return unit;
}

/**
 * Literal coverage of emitted codes, events and console lines. A code or
 * message is followed through local `const` bindings and through parameters
 * of top-level helper functions to every call site, in the same file and in
 * every file that imports the helper. Sites still computed after that are
 * recorded by file, enclosing function and emitter kind, never by line, so
 * unrelated edits leave them unchanged.
 */
export function scanRuntimeErrors(files = runtimeSources()) {
	const units = files.map(prepare);
	const sitesOf = new Map();
	// A method helper (`{ fail(code, error) {...} }`) is matched by name to
	// every `<object>.fail(...)` call in its own file: a false positive is
	// possible, a missed call site is not.
	function methodSites(unit, fn, name) {
		if (sitesOf.has(fn)) return sitesOf.get(fn);
		const sites = unit.methodCalls.filter(({ call }) => call.callee.property.name === name).map(entry => ({ unit, ...entry }));
		sitesOf.set(fn, sites);
		return sites;
	}
	function callSites(unit, fn) {
		if (sitesOf.has(fn)) return sitesOf.get(fn);
		const exported = unit.ast.body.some(item => item.type === 'ExportNamedDeclaration' && item.declaration === fn);
		const sites = [];
		for (const caller of units) {
			for (const { call, parents } of caller.calls) {
				if (call.callee.name !== fn.id.name && caller === unit) continue;
				const found = binding(call.callee.name, parents);
				if (caller === unit && found?.declaration === fn) sites.push({ unit: caller, call, parents });
				else if (exported && found?.imported === fn.id.name && found.from.startsWith('.') &&
					posix.join(posix.dirname(caller.path), found.from) === unit.path) sites.push({ unit: caller, call, parents });
			}
		}
		sitesOf.set(fn, sites);
		return sites;
	}
	const isTopLevel = (unit, fn) => fn.type === 'FunctionDeclaration' &&
		unit.ast.body.some(item => item === fn || (item.type === 'ExportNamedDeclaration' && item.declaration === fn));
	// A reference is a node with the file and scope it is read in.
	function deref(ref) {
		if (ref.node?.type !== 'Identifier' || constants.has(ref.node.name)) return ref;
		const found = binding(ref.node.name, ref.parents);
		const init = found?.kind === 'const' ? found.declaration.init : undefined;
		return init && RESOLVABLE_INIT.has(init.type) && init !== ref.node ? { ...ref, node: init } : ref;
	}
	const parameterOf = ref => {
		if (ref?.node?.type !== 'Identifier') return undefined;
		const found = binding(ref.node.name, ref.parents);
		if (!found?.parameter) return undefined;
		if (isTopLevel(ref.unit, found.scope)) return found;
		const method = ['Property', 'MethodDefinition'].includes(found.owner?.type) && !found.owner.computed ? found.owner.key.name : undefined;
		return method ? { ...found, method } : undefined;
	};
	/**
	 * Resolve one emitter's code and message to rows of [codes, messages, path].
	 * @returns {{ rows: Array<[string[], string[], string]>, complete: boolean }}
	 */
	function resolveEmitter(codeRef, messageRef, depth = 0) {
		codeRef = inUnit(codeRef.unit, () => deref(codeRef));
		if (messageRef) messageRef = inUnit(messageRef.unit, () => deref(messageRef));
		const codeParam = parameterOf(codeRef), messageParam = parameterOf(messageRef);
		const helper = codeParam?.scope ?? messageParam?.scope;
		if (helper && (!codeParam || !messageParam || codeParam.scope === messageParam.scope)) {
			if (depth >= MAX_HELPER_DEPTH) return { rows: [], complete: false };
			const helperUnit = (codeParam ? codeRef : messageRef).unit;
			const param = codeParam ?? messageParam;
			const sites = param.method ? methodSites(helperUnit, helper, param.method) : callSites(helperUnit, helper);
			const out = { rows: [], complete: sites.length > 0 };
			for (const site of sites) {
				const argument = (param, ref) => {
					if (!param) return ref;
					if (site.call.arguments.slice(0, param.index + 1).some(arg => arg.type === 'SpreadElement')) return { unit: site.unit, parents: site.parents, node: undefined };
					const arg = site.call.arguments[param.index];
					return arg ? { unit: site.unit, parents: site.parents, node: arg }
						: { unit: helperUnit, parents: ref.parents, node: param.parameter.type === 'AssignmentPattern' ? param.parameter.right : undefined };
				};
				const result = resolveEmitter(argument(codeParam, codeRef), messageRef && argument(messageParam, messageRef), depth + 1);
				out.rows.push(...result.rows);
				out.complete &&= result.complete;
			}
			return out;
		}
		const codes = inUnit(codeRef.unit, () => literals(codeRef.node));
		const codeComplete = inUnit(codeRef.unit, () => complete(codeRef.node));
		if (!messageRef) return { rows: [[codes, codes, codeRef.unit.path]], complete: codeComplete };
		const messageComplete = inUnit(messageRef.unit, () => complete(messageRef.node, true));
		const pairs = codeRef.unit === messageRef.unit
			? inUnit(codeRef.unit, () => codeMessages(codeRef.node, codes, messageRef.node, codeRef.unit.source))
			: [[codes, inUnit(messageRef.unit, () => patterns(messageRef.node))]];
		return { rows: pairs.map(([owned, messages]) => [owned, messages, codeRef.unit.path]), complete: codeComplete && messageComplete };
	}

	const errors = new Map(), diagnostics = new Map(), dynamic = new Map(), consoleSites = [];
	function record(map, key, messages, path, extra = {}) {
		let row = map.get(key);
		if (!row) { row = { key, prefixes: new Set(), sources: new Set(), ...extra }; map.set(key, row); }
		for (const text of messages) row.prefixes.add(text);
		row.sources.add(path);
		return row;
	}
	for (const unit of units) {
		const { path, source, ast } = unit;
		constants = unit.constants;
		walk(ast, (node, parents) => {
			const site = kind => {
				const scope = enclosingName(parents);
				const key = path + '\0' + scope + '\0' + kind;
				const row = dynamic.get(key) ?? { path, scope, kind, count: 0 };
				row.count++;
				dynamic.set(key, row);
			};
			const local = value => deref({ unit, parents, node: value }).node;
			if (node.type === 'NewExpression' && ['LiveError', 'RpcError'].includes(node.callee?.name)) {
				const ref = value => ({ unit, parents, node: value });
				const result = resolveEmitter(ref(node.arguments[0]), node.arguments.length > 1 ? ref(node.arguments[1]) : undefined);
				constants = unit.constants;
				if (!result.complete) site('new ' + node.callee.name);
				for (const [owned, messages, owner] of result.rows) {
					for (const code of owned) {
						record(errors, code, messages, owner);
						record(errors, code, [], path);
					}
				}
			}
			if (node.type === 'AssignmentExpression' && node.operator === '=' && node.left.type === 'MemberExpression' && !node.left.computed && node.left.property.name === 'code') {
				const message = assignedErrorMessage(node, parents);
				if (message) {
					const value = local(node.right);
					const codes = literals(value);
					for (const code of codes) record(errors, code, patterns(message), path);
					if (!complete(value) || !complete(message, true)) site('Error.code');
				}
			}
			if (node.type === 'ObjectExpression') {
				const fields = properties(node);
				if (fields.ok?.value === false && fields.code && fields.error) {
					const code = local(fields.code), error = local(fields.error);
					const codes = literals(code), message = patterns(error);
					if (!complete(code) || !complete(error, true)) site('error reply');
					for (const entry of codes) record(errors, entry, message, path);
				}
				if (fields.event && fields.component && (fields.severity || fields.level)) {
					const event = local(fields.event), text = fields.message && local(fields.message);
					const message = patterns(text);
					if (!complete(event) || !complete(text, true)) site('structured event');
					for (const [name, severities] of eventSeverities(event, local(fields.severity || fields.level), source)) {
						const row = record(diagnostics, name, message, path, { kind: 'structured event', severities: new Set(), delivery: new Set() });
						// A record built with createDiagnostic() is delivered by the call it is passed to.
						const calleeAt = depth => parents.at(depth)?.type === 'CallExpression' ? parents.at(depth).callee?.name : undefined;
						const callee = calleeAt(-1) === 'createDiagnostic' ? calleeAt(-2) : calleeAt(-1);
						if (callee && Object.hasOwn(DELIVERY, callee)) row.delivery.add(DELIVERY[callee]);
						// An unresolved severity counts as a failure, never as informational.
						for (const severity of severities.length ? severities : ['unresolved']) row.severities.add(severity);
					}
				}
			}
			const method = consoleMethod(node, unit);
			if (method) {
				const first = local(node.arguments[0]);
				const message = patterns(first);
				// Structured diagnostics are indexed by the object carrying their event.
				if (!message.length) {
					if (first?.arguments?.[0]?.type !== 'ObjectExpression') site(method);
					return;
				}
				if (!complete(first, true)) site(method);
				const registered = first?.type === 'CallExpression' && first.callee?.name === 'realtimeErrorMessage';
				const registryId = registered ? definition(first)?.id : undefined;
				for (const text of message) {
					const id = 'console-' + createHash('sha256').update(text).digest('hex').slice(0, 16);
					record(diagnostics, id, [text], path, { kind: 'console line' });
					consoleSites.push({ path, method, text, id, registered, registryId });
				}
			}
		});
	}
	constants = new Map();
	const finish = (map, kind) => [...map.values()].sort((a, b) => compare(a.key, b.key)).map(row => ({
		...row, anchor: anchor(kind, row.key), prefixes: sorted(row.prefixes), sources: sorted(row.sources),
		...(row.severities ? { severities: sorted(row.severities), delivery: sorted(row.delivery) } : {})
	}));
	const dynamicSites = [...dynamic.values()].sort((a, b) => compare(a.path, b.path) || compare(a.scope, b.scope) || compare(a.kind, b.kind));
	const uniqueConsole = [...new Map(consoleSites.map(entry => [entry.path + '::' + entry.text, entry])).values()]
		.sort((a, b) => compare(a.path, b.path) || compare(a.text, b.text));
	return { errors: finish(errors, 'live-error'), diagnostics: finish(diagnostics, 'diagnostic'), dynamicSites, consoleSites: uniqueConsole };
}

/** Stable decision key of a dynamic site: file, enclosing function and emitter. */
export const dynamicSiteKey = site => site.path + '::' + site.scope + '::' + site.kind;
/** Stable decision key of a console line: file and its whole printed pattern. */
export const consoleSiteKey = site => site.path + '::' + site.text;

/** True when every severity an event is emitted at reports normal operation. */
export function isInformational(row) {
	return row.kind === 'structured event' && row.severities.length > 0 && row.severities.every(severity => INFORMATIONAL_SEVERITIES.includes(severity));
}
