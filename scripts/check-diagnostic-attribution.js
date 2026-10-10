#!/usr/bin/env node
/** Reject warning/error call sites whose first console argument has no owned diagnostic family. */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'acorn';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourceRoot = join(root, 'src');
const families = [
	['canonical', /^\[lantean\/diagnostic /],
	['realtime', /^\[(?:svelte-realtime|realtime\/(?:assert|fatal))\]/]
];
const formatters = new Set(['formatDiagnostic']);

function files(dir) {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const path = join(dir, entry.name);
		return entry.isDirectory() ? files(path) : entry.name.endsWith('.js') ? [path] : [];
	});
}

const counts = new Map(families.map(([name]) => [name, 0]));
const failures = [];
function leadingText(node) {
	if (node?.type === 'Literal' && typeof node.value === 'string') return node.value;
	if (node?.type === 'TemplateLiteral') return node.quasis[0]?.value.raw ?? '';
	if (node?.type === 'BinaryExpression' && node.operator === '+') return leadingText(node.left);
	return '';
}
function walk(node, visit) {
	if (!node || typeof node !== 'object') return;
	visit(node);
	for (const value of Object.values(node)) {
		if (Array.isArray(value)) for (const child of value) walk(child, visit);
		else if (value && typeof value === 'object' && typeof value.type === 'string') walk(value, visit);
	}
}
for (const path of files(sourceRoot)) {
	const source = readFileSync(path, 'utf8');
	const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module', locations: true });
	walk(ast, (node) => {
		if (node.type !== 'CallExpression' || node.callee?.type !== 'MemberExpression' ||
			node.callee.object?.name !== 'console' || !['warn', 'error'].includes(node.callee.property?.name)) return;
		const first = node.arguments[0];
		if (first?.type === 'CallExpression' && first.callee?.type === 'Identifier' && formatters.has(first.callee.name)) {
			counts.set('canonical', counts.get('canonical') + 1);
			return;
		}
		const text = leadingText(first);
		const family = families.find(([, pattern]) => pattern.test(text));
		if (family) {
			counts.set(family[0], counts.get(family[0]) + 1);
			return;
		}
		failures.push(`${relative(root, path)}:${node.loc.start.line}: console.${node.callee.property.name} first argument is not package-attributed`);
	});
}

if (failures.length > 0) {
	for (const failure of failures) console.error(`check-diagnostic-attribution: ${failure}`);
	console.error(`check-diagnostic-attribution: ${failures.length} unattributed warning/error call site(s)`);
	process.exit(1);
}
console.log(`check-diagnostic-attribution: ${[...counts].map(([name, count]) => `${name}=${count}`).join(', ')}`);
