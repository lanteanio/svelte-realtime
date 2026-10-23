// A live export inside a comment or a string is not an export: the plugin
// must give it no client stub, SSR stub, registry entry or declaration.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { resolve } from 'path';
import svelteRealtime from '../src/vite.js';
import { _fileCache, _codeCache, _warnedExports } from '../src/vite/source-cache.js';
import { _generateTypeDeclarations } from '../src/vite/codegen-types.js';
import { _locate, _rememberScan } from '../src/vite/scanner.js';

const testRoot = resolve(import.meta.dirname, '__fixtures_commented_exports__');
const liveDir = resolve(testRoot, 'src/live');

function setup(files) {
	mkdirSync(liveDir, { recursive: true });
	for (const [name, content] of Object.entries(files)) writeFileSync(resolve(liveDir, name), content);
}

function createPlugin() {
	const plugin = svelteRealtime({ dir: 'src/live' });
	plugin.configResolved({ root: testRoot, build: {} });
	return plugin;
}

function code(out) {
	return typeof out === 'string' ? out : out?.code;
}

function captureWarns(fn) {
	const warns = [];
	const orig = console.warn;
	console.warn = (...args) => warns.push(args.join(' '));
	try { return { value: fn(), warns }; } finally { console.warn = orig; }
}

const hidden = ['lineRpc', 'lineStream', 'blockRpc', 'blockStream', 'docRpc', 'quotedRpc', 'templateRpc', 'blockGuard'];

const source = [
	"import { live, guard } from 'svelte-realtime/server';",
	'// export const lineRpc = live.public(async () => 1);',
	"// export const lineStream = live.stream('old:line', async () => []);",
	'/*',
	'export const blockRpc = live(async () => 2);',
	"export const blockStream = live.stream('old:block', async () => []);",
	'export const _guard = guard(() => {});',
	'*/',
	'/**',
	' * @example',
	' * export const docRpc = live(async () => 3);',
	' */',
	'const quoted = "export const quotedRpc = live(async () => 4);";',
	'const template = `',
	'export const templateRpc = live(async () => 5);',
	'`;',
	'export const current = live(async () => quoted + template);',
	"export const feed = live.stream('current:feed', async () => []);",
	''
].join('\n');

describe('commented and quoted live exports', () => {
	beforeEach(() => {
		_fileCache.clear();
		_codeCache.clear();
		_warnedExports.clear();
	});
	afterEach(() => {
		if (existsSync(testRoot)) rmSync(testRoot, { recursive: true, force: true });
	});

	it('get no client stub, SSR stub, registry entry or declaration; real exports do', () => {
		setup({ 'mixed.js': source });
		const plugin = createPlugin();
		const { value: client, warns } = captureWarns(() => code(plugin.load('\0live:mixed', { ssr: false })));
		const ssr = code(plugin.load('\0live:mixed', { ssr: true }));
		const registry = code(plugin.load('\0live:__registry', { ssr: true }));
		const dts = _generateTypeDeclarations(liveDir, 'src/live');

		expect(client).toContain('export const current = __rpc("mixed/current")');
		expect(client).toContain('export const feed = __stream("mixed/feed"');
		expect(registry).toContain('"mixed/current"');
		expect(registry).toContain('"mixed/feed"');
		expect(ssr).toContain('"mixed/feed"');
		expect(dts).toMatch(/export const current:/);
		expect(dts).toMatch(/export const feed:/);

		for (const name of hidden) {
			const word = new RegExp(`\\b${name}\\b`);
			expect(client).not.toMatch(word);
			expect(ssr.replace(/export \* from .*/, '')).not.toMatch(word);
			expect(registry).not.toMatch(word);
			expect(dts).not.toMatch(word);
		}
		// The commented-out _guard does not count, so the module is unguarded.
		expect(warns.some((w) => w.includes('_guard'))).toBe(true);
	});

	it('the same declarations uncommented are all generated', () => {
		const uncommented = source
			.replace(/^\/\/ /gm, '')
			.replace(/^\/\*\*?$|^ \*\/$|^\*\/$|^ \* @example$/gm, '')
			.replace(/^ \* /gm, '')
			.replace('const quoted = "export const quotedRpc = live(async () => 4);";', 'export const quotedRpc = live(async () => 4);\nconst quoted = "";')
			.replace('const template = `\nexport const templateRpc = live(async () => 5);\n`;', 'export const templateRpc = live(async () => 5);\nconst template = "";');
		setup({ 'open.js': uncommented });
		const plugin = createPlugin();
		const { value: client, warns } = captureWarns(() => code(plugin.load('\0live:open', { ssr: false })));
		const registry = code(plugin.load('\0live:__registry', { ssr: true }));
		for (const name of hidden.filter((n) => n !== 'blockGuard')) {
			expect(client).toMatch(new RegExp(`export const ${name} = __(rpc|stream)\\(`));
			expect(registry).toContain(`"open/${name}"`);
		}
		expect(warns.some((w) => w.includes('_guard'))).toBe(false);
	});

	it('reads values that contain the word export as written', () => {
		setup({
			'values.js': [
				"import { live, guard } from 'svelte-realtime/server';",
				'export const _guard = guard(() => {});',
				"export const features = live.flag('features:export', false);",
				// Declaration-shaped text inside a value: found in the scan view,
				// read from the source as written.
				"export const odd = live.flag('export default', 0);",
				"export const rows = live.stream('rows', async () => [], { key: 'export', merge: 'crud' });",
				'export const label = live(async (ctx, o) => `${o.export} export ${`export const x = 1`}`);',
				''
			].join('\n'),
			'typed.ts': [
				"import { live, guard } from 'svelte-realtime/server';",
				'export const _guard = guard(() => {});',
				"export const mode = live(async (ctx): Promise<'export' | 'import'> => 'export');",
				''
			].join('\n')
		});
		const plugin = createPlugin();
		const client = code(plugin.load('\0live:values', { ssr: false }));
		const registry = code(plugin.load('\0live:__registry', { ssr: true }));
		const dts = _generateTypeDeclarations(liveDir, 'src/live');
		expect(registry).toContain('__registerFlag("features:export", false)');
		expect(registry).toContain('__registerFlag("export default", 0)');
		expect(client).toContain('"key":"export"');
		expect(client).toContain('export const label = __rpc("values/label")');
		expect(dts).toContain("'export' | 'import'");
		for (const out of [client, registry, dts]) expect(out).not.toContain('_xport');
	});

	it('warns once when a live export is read as string text at the start of a line', () => {
		setup({
			'misread.js': [
				"import { live } from 'svelte-realtime/server';",
				'const note = `',
				'export const ghost = live(async () => 1);',
				'`;',
				'export const real = live.public(async () => 2);',
				''
			].join('\n')
		});
		const plugin = createPlugin();
		const { value: client, warns } = captureWarns(() => {
			const out = code(plugin.load('\0live:misread', { ssr: false }));
			plugin.load('\0live:misread', { ssr: true });
			plugin.load('\0live:__registry', { ssr: true });
			_generateTypeDeclarations(liveDir, 'src/live');
			return out;
		});
		expect(client).toContain('export const real = __rpc(');
		expect(client).not.toMatch(/\bghost\b/);
		const misread = warns.filter((w) => w.includes('looks like a live export'));
		expect(misread).toHaveLength(1);
		expect(misread[0]).toContain("src/live/misread: 'ghost'");

		// Cleared with the other export warnings, so a new build warns again.
		_warnedExports.clear();
		_codeCache.clear();
		const again = captureWarns(() => createPlugin().load('\0live:misread', { ssr: false })).warns;
		expect(again.filter((w) => w.includes('looks like a live export'))).toHaveLength(1);
	});

	it('_locate finds a match in the scan view but reads it only from the source', () => {
		// Same length, different text at the found offset: no match, rather
		// than a value taken from the scan view.
		_rememberScan('x = live.fla9(1)', 'x = live.flag(1)');
		expect(_locate(/live\.flag\((\d)\)/, 'x = live.fla9(1)')).toBeNull();
		_rememberScan('y = live.flag(2)', 'y = live.flag(2)');
		expect(_locate(/live\.flag\((\d)\)/, 'y = live.flag(2)')?.[1]).toBe('2');
		_rememberScan("const a = 'export const b = 1'; z = live.flag(3)", "const a = '_xport const b = 1'; z = live.flag(3)");
		const m = _locate(/'([^']*)'/, "const a = 'export const b = 1'; z = live.flag(3)");
		expect(m?.[1]).toBe('export const b = 1');
	});
});
