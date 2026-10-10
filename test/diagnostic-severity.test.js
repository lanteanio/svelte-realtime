import { expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'acorn';
import { TELEMETRY_LEVELS, setOperationalEventSink } from 'svelte-adapter-uws/observability';
import { live } from '../src/server.js';

const levels = new Set(TELEMETRY_LEVELS);
function strings(node) {
	if (node?.type === 'Literal' && typeof node.value === 'string') return [node.value];
	if (node?.type === 'TemplateLiteral' && node.expressions.length === 0) return [node.quasis[0].value.cooked];
	if (node?.type === 'ConditionalExpression') return [...strings(node.consequent), ...strings(node.alternate)];
	return [];
}
function severities(source) {
	const values = [];
	function walk(node) {
		if (!node || typeof node !== 'object') return;
		if (node.type === 'Property' && (node.key.name === 'severity' || node.key.value === 'severity')) {
			for (const value of strings(node.value)) values.push({ value, line: node.loc.start.line });
		}
		for (const child of Object.values(node)) {
			if (Array.isArray(child)) child.forEach(walk);
			else if (child?.type) walk(child);
		}
	}
	walk(parse(source, { ecmaVersion: 'latest', sourceType: 'module', locations: true }));
	return values;
}
function sources(directory) {
	return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
		const path = join(directory, entry.name);
		return entry.isDirectory() ? sources(path) : entry.name.endsWith('.js') ? [path] : [];
	});
}
it('checks literal telemetry levels without mistaking comments or type examples for emissions', () => {
	const source = "/* severity: 'warning' */ const value = { severity: ready ? 'warn' : 'info' }; const other = { ['severity']: 'critical' };";
	expect(severities(source).map(entry => entry.value)).toEqual(['warn', 'info', 'critical']);
	for (const value of ['warning', 'critical', 'notice', 'err']) expect(levels.has(severities('const event = { severity: ' + JSON.stringify(value) + ' };')[0].value)).toBe(false);
});
it('keeps every source severity literal within the installed telemetry contract', () => {
	const root = fileURLToPath(new URL('../src/', import.meta.url));
	const values = sources(root).flatMap(path => severities(readFileSync(path, 'utf8')).map(entry => ({ ...entry, file: relative(root, path) })));
	expect(values.length).toBeGreaterThan(0);
	expect(values.filter(entry => !levels.has(entry.value))).toEqual([]);
});
it('delivers an actual circuit-breaker refusal as a warn event to the shared sink', async () => {
	const records = [];
	const restore = setOperationalEventSink(record => records.push(record));
	try {
		const guarded = live.breaker({ name: 'catalog', breaker: { guard() { throw Object.assign(new Error('open'), { name: 'CircuitBrokenError' }); } } }, async () => 'available');
		await expect(guarded({})).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
		expect(records).toEqual([expect.objectContaining({ source: 'svelte-realtime', event: 'breaker.open', severity: 'warn', attributes: expect.objectContaining({ name: 'catalog' }) })]);
	} finally { restore(); }
});
