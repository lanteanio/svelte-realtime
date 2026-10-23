// A live export inside a comment or a string is not an export: the plugin
// must give it no client stub, SSR stub, registry entry or declaration.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { resolve } from 'path';
import svelteRealtime from '../src/vite.js';
import { _fileCache, _codeCache, _warnedExports } from '../src/vite/source-cache.js';
import { _generateTypeDeclarations } from '../src/vite/codegen-types.js';

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
});
