// Build-time inventory only; runtime messages are never changed by this scanner.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'acorn';
import { REALTIME_ERROR_IDS, REALTIME_ERROR_REGISTRY } from '../src/error-registry.js';

const root = resolve(import.meta.dirname, '..');
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const registry = new Map(REALTIME_ERROR_REGISTRY.map(entry => [entry.id, entry]));
function sources(directory = 'src') {
	return readdirSync(resolve(root, directory), { withFileTypes: true }).flatMap(entry => {
		const path = directory + '/' + entry.name;
		return entry.isDirectory() ? sources(path)
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
function literals(node) {
	if (node?.type === 'Literal' && typeof node.value === 'string') return [node.value];
	if (node?.type === 'ConditionalExpression') return [...literals(node.consequent), ...literals(node.alternate)];
	if (node?.type === 'CallExpression' && node.callee?.name === 'realtimeErrorCode') return [definition(node)?.code].filter(Boolean);
	return [];
}
function prefixes(node) {
	if (node?.type === 'ConditionalExpression') return [...prefixes(node.consequent), ...prefixes(node.alternate)];
	const values = literals(node);
	if (values.length) return values;
	if (node?.type === 'TemplateLiteral') return [node.quasis[0]?.value.cooked ?? ''].filter(Boolean);
	if (node?.type === 'BinaryExpression' && node.operator === '+') return prefixes(node.left);
	if (node?.type === 'CallExpression' && node.callee?.name === 'realtimeErrorMessage') return [definition(node)?.messagePrefix].filter(Boolean);
	return [];
}
function complete(node, prefix = false) {
	if (node?.type === 'ConditionalExpression') return complete(node.consequent, prefix) && complete(node.alternate, prefix);
	if (prefix && node?.type === 'BinaryExpression' && node.operator === '+') return complete(node.left, true);
	if (prefix && node?.type === 'TemplateLiteral') return Boolean(node.quasis[0]?.value.cooked);
	if (node?.type === 'CallExpression' && node.callee?.name === (prefix ? 'realtimeErrorMessage' : 'realtimeErrorCode')) return Boolean(definition(node));
	return node?.type === 'Literal' && typeof node.value === 'string';
}
function properties(node) {
	return Object.fromEntries(node.properties.filter(property => property.type === 'Property' && !property.computed)
		.map(property => [property.key.name ?? property.key.value, property.value]));
}
// Resolve only local declarations and literal arguments of named local helpers.
// Unknown arguments remain dynamic; no application-provided value is inferred.
function localValues(node, parents, ast) {
	if (node?.type !== 'Identifier') return literals(node);
	for (const scope of [...parents].reverse()) {
		if (scope.type === 'FunctionDeclaration' && ast.body.includes(scope)) {
			const index = scope.params.findIndex(param => (param.type === 'AssignmentPattern' ? param.left : param).name === node.name);
			if (index < 0) continue;
			const values = literals(scope.params[index].right);
			walk(ast, call => {
				if (call.type === 'CallExpression' && call.callee.name === scope.id?.name) values.push(...literals(call.arguments[index]));
			});
			return values;
		}
	}
	return [];
}
function assignedErrorMessage(node, parents) {
	const name = node.left.object?.name;
	for (const scope of [...parents].reverse()) {
		if (scope.type !== 'BlockStatement' && scope.type !== 'Program') continue;
		for (const statement of scope.body) {
			if (statement.start >= node.start) break;
			if (statement.type !== 'VariableDeclaration') continue;
			const declaration = statement.declarations.find(item => item.id.name === name);
			if (declaration) return statement.kind === 'const' && declaration.init?.type === 'NewExpression' && declaration.init.callee.name === 'Error' ? declaration.init.arguments[0] : undefined;
		}
	}
}
const sorted = values => [...new Set(values)].sort();
const anchor = (kind, key) => kind === 'diagnostic' ? kind + '-' + encodeURIComponent(key)
	: kind + '-' + key.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/** Literal coverage, not full cause/recovery guidance. Dynamic sites are listed explicitly. */
export function scanRuntimeErrors(files = sources()) {
	const errors = new Map(), diagnostics = new Map();
	const dynamicSites = new Set();
	function record(map, key, prefix, path, extra = {}) {
		let row = map.get(key);
		if (!row) { row = { key, prefixes: new Set(), sources: new Set(), ...extra }; map.set(key, row); }
		for (const text of prefix) row.prefixes.add(text);
		row.sources.add(path);
	}
	for (const { path, source } of files) {
		const ast = parse(source, { sourceType: 'module', ecmaVersion: 'latest', locations: true });
		walk(ast, (node, parents) => {
			if (node.type === 'NewExpression' && ['LiveError', 'RpcError'].includes(node.callee?.name)) {
				const codes = localValues(node.arguments[0], parents, ast);
				const message = node.arguments.length < 2 ? codes : prefixes(node.arguments[1]);
				if (!complete(node.arguments[0]) || (node.arguments.length > 1 && !complete(node.arguments[1], true))) dynamicSites.add(path + ':' + node.loc.start.line);
				for (const code of codes) record(errors, code, message, path);
			}
			if (node.type === 'AssignmentExpression' && node.operator === '=' && node.left.type === 'MemberExpression' && !node.left.computed && node.left.property.name === 'code') {
				const message = assignedErrorMessage(node, parents);
				if (message) {
					const codes = literals(node.right);
					for (const code of codes) record(errors, code, prefixes(message), path);
					if (!complete(node.right) || !complete(message, true)) dynamicSites.add(path + ':' + node.loc.start.line);
				}
			}
			if (node.type === 'ObjectExpression') {
				const fields = properties(node);
				if (fields.ok?.value === false && fields.code && fields.error) {
					const codes = literals(fields.code), message = prefixes(fields.error);
					if (!complete(fields.code) || !complete(fields.error, true)) dynamicSites.add(path + ':' + node.loc.start.line);
					for (const code of codes) record(errors, code, message, path);
				}
				if (fields.event && fields.component && (fields.severity || fields.level)) {
					const events = literals(fields.event), message = prefixes(fields.message);
					if (!complete(fields.event) || !complete(fields.message, true)) dynamicSites.add(path + ':' + node.loc.start.line);
					for (const event of events) record(diagnostics, event, message, path, { kind: 'structured event' });
				}
			}
			if (node.type === 'CallExpression' && node.callee?.type === 'MemberExpression' &&
				node.callee.object?.name === 'console' && ['warn', 'error'].includes(node.callee.property?.name)) {
				const message = prefixes(node.arguments[0]);
				// Structured diagnostics are indexed by the object carrying their event.
				if (!message.length) {
					if (node.arguments[0]?.arguments?.[0]?.type !== 'ObjectExpression') dynamicSites.add(path + ':' + node.loc.start.line);
					return;
				}
				if (!complete(node.arguments[0], true)) dynamicSites.add(path + ':' + node.loc.start.line);
				for (const prefix of message) {
					const id = 'console-' + createHash('sha256').update(prefix).digest('hex').slice(0, 16);
					record(diagnostics, id, [prefix], path, { kind: 'legacy console prefix' });
				}
			}
		});
	}
	const finish = (map, kind) => [...map.values()].sort((a, b) => compare(a.key, b.key)).map(row => ({
		...row, anchor: anchor(kind, row.key), prefixes: sorted(row.prefixes), sources: sorted(row.sources)
	}));
	return { errors: finish(errors, 'live-error'), diagnostics: finish(diagnostics, 'diagnostic'), dynamicSites: sorted(dynamicSites) };
}

function literal(value) {
	return '<code>' + value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
		.replaceAll('|', '&#124;').replaceAll('\r', '\\r').replaceAll('\n', '\\n') + '</code>';
}
function sourceLinks(paths) {
	return paths.map(path => '[' + path + '](../' + path + ')').join(', ');
}
export function renderRuntimeInventory(inventory = scanRuntimeErrors(), guidance = REALTIME_ERROR_REGISTRY) {
	const guidedCodes = new Set(guidance.map(entry => entry.code).filter(Boolean));
	const lines = [
		'## Emitted error coverage', '',
		'Coverage listing only: the scanner inventories direct LiveError and RpcError constructors, literal arguments of local error helpers, code assignments on locally declared Error objects, error reply objects, structured diagnostic events, and console warning/error prefixes in src/**/*.js. Comments and example declarations are excluded. It does not infer causes or safe recovery actions from strings.', '',
		'Full cause, consequence, recovery and next-action guidance above covers ' + guidance.length + ' registered events (' + guidedCodes.size + ' distinct runtime codes). The source inventory below currently finds ' + inventory.errors.length + ' literal runtime codes and ' + inventory.diagnostics.length + ' operational event/prefix entries. A code appearing here does not mean every occurrence has full guidance.', '',
		'Code anchors stay stable when messages change. Structured diagnostic IDs use the emitted event; legacy console IDs are derived from the literal prefix and change when that prefix changes. These coverage IDs are documentation anchors, not IDs appended to legacy runtime messages. Escaped \\n and \\r in the listing stand for actual newlines and carriage returns.', ''
	];
	for (const row of inventory.errors) {
		lines.push('<a id="' + row.anchor + '"></a>', '### ' + literal(row.key), '',
			'- Searchable message prefixes: ' + (row.prefixes.length ? row.prefixes.map(literal).join('; ') : 'dynamic (inspect the owning source).'),
			'- Owning sources: ' + sourceLinks(row.sources), '');
	}
	lines.push('## Operational prefix index', '');
	for (const row of inventory.diagnostics) {
		lines.push('<a id="' + row.anchor + '"></a>', '### ' + literal(row.key), '',
			'- Kind: ' + row.kind,
			'- Searchable message prefixes: ' + (row.prefixes.length ? row.prefixes.map(literal).join('; ') : 'dynamic (search the event ID).'),
			'- Owning sources: ' + sourceLinks(row.sources), '');
	}
	lines.push('## Dynamic emission sites', '',
		'These sites have a computed code, event, or message prefix that the literal scanner cannot resolve. They remain visible here instead of being counted as full literal coverage. Wire forwarding and application-provided messages may vary at runtime.', '',
		...inventory.dynamicSites.map(site => '- ' + literal(site)), '');
	return lines.join('\n');
}
