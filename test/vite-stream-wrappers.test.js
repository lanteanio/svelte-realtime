// live.public, live.gate and live.scoped around a stream keep it a stream: the
// server answers a stream path only to a subscribe, so the generated client,
// SSR stub, registry and declarations must treat the wrapped export exactly as
// the stream it wraps.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { resolve } from 'path';
import svelteRealtime from '../src/vite.js';
import { _fileCache, _codeCache, _warnedExports } from '../src/vite/source-cache.js';
import { _generateTypeDeclarations } from '../src/vite/codegen-types.js';

const testRoot = resolve(import.meta.dirname, '__fixtures_stream_wrappers__');
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
	try { fn(); } finally { console.warn = orig; }
	return warns;
}

/** The generated line for `name`, with the module and export name replaced. */
function lineFor(text, mod, name) {
	const line = text.split('\n').find((l) => new RegExp(`\\b${name}\\b`).test(l) && !l.startsWith('import'));
	return line?.replaceAll(mod + '/', 'M/').replace(new RegExp(`\\b${name}\\b`, 'g'), 'X');
}

const header = `import { live, guard } from 'svelte-realtime/server';\nexport const _guard = guard(() => {});\n`;

const cases = [
	['live.public(live.stream)', `live.public(live.stream('t1', async () => [], { merge: 'latest', max: 20 }))`, `live.stream('t1', async () => [], { merge: 'latest', max: 20 })`],
	['live.public(dynamic live.stream)', `live.public(live.stream((ctx, id) => 'd:' + id, async (ctx, id) => [], { key: 'slug' }))`, `live.stream((ctx, id) => 'd:' + id, async (ctx, id) => [], { key: 'slug' })`],
	['live.gate(pred, live.stream)', `live.gate(\n  (ctx) => !!ctx.user,\n  live.stream('t2', async () => [], { merge: 'set' })\n)`, `live.stream('t2', async () => [], { merge: 'set' })`],
	['live.scoped(pred, live.stream)', `live.scoped((ctx) => true, live.stream('t3', async () => []),)`, `live.stream('t3', async () => [])`],
	['live.public(live.channel)', `live.public(live.channel('c1', { merge: 'latest' }))`, `live.channel('c1', { merge: 'latest' })`],
	['live.gate(pred, live.channel)', `live.gate(() => true, live.channel('c2'))`, `live.channel('c2')`],
	['live.public(live.derived)', `live.public(live.derived(['src'], async () => 1))`, `live.derived(['src'], async () => 1)`],
	['live.public(live.flag)', `live.public(live.flag('f1', false))`, `live.flag('f1', false)`],
	['live.public(live.aggregate)', `live.public(live.aggregate('orders', { n: { init: () => 0, reduce: (n) => n + 1 } }, { topic: 'n1' }))`, `live.aggregate('orders', { n: { init: () => 0, reduce: (n) => n + 1 } }, { topic: 'n1' })`],
	['live.public(live.gate(pred, live.stream))', `live.public(live.gate(() => true, live.stream('t4', async () => [])))`, `live.stream('t4', async () => [])`]
];

describe('codegen for wrapped streams', () => {
	beforeEach(() => {
		_fileCache.clear();
		_codeCache.clear();
		_warnedExports.clear();
	});
	afterEach(() => {
		if (existsSync(testRoot)) rmSync(testRoot, { recursive: true, force: true });
	});

	for (const [label, wrapped, plain] of cases) {
		it(`${label} generates what the unwrapped declaration generates`, () => {
			setup({
				'wrapped.js': header + `export const feed = ${wrapped};\n`,
				// Its own topic: a wrapped stream's topic counts toward the duplicate check.
				'plain.js': header + `export const feed = ${plain.replace(/'(t\d)'/, "'$1p'")};\n`
			});
			const plugin = createPlugin();
			const warns = captureWarns(() => {
				const client = (mod) => lineFor(code(plugin.load('\0live:' + mod, { ssr: false })), mod, 'feed');
				const wrappedClient = client('wrapped');
				expect(wrappedClient).toContain('__stream(');
				expect(wrappedClient).toBe(client('plain'));

				const ssr = (mod) => code(plugin.load('\0live:' + mod, { ssr: true })).split('\n').filter((l) => l.includes('feed')).map((l) => l.replaceAll(mod, 'M')).join('\n');
				expect(ssr('wrapped').replace(/"[^"]*M\.js"/g, '""')).toBe(ssr('plain').replace(/"[^"]*M\.js"/g, '""'));

				const registry = code(plugin.load('\0live:__registry', { ssr: true })).split('\n');
				const reg = (mod) => registry.filter((l) => l.includes(mod + '/feed') || l.includes(mod + '.js')).map((l) => l.replaceAll(mod, 'M')).sort();
				expect(reg('wrapped')).toEqual(reg('plain'));
			});
			expect(warns.filter((w) => w.includes('not wrapped in live()'))).toEqual([]);

			const dts = _generateTypeDeclarations(liveDir, 'src/live');
			const block = (mod) => {
				const start = dts.indexOf(`declare module "$live/${mod}"`);
				const end = dts.indexOf('\n}', start);
				return dts.slice(start, end).split('\n').filter((l) => /\bfeed\b/.test(l)).join('\n');
			};
			expect(block('wrapped')).toMatch(/StreamStore|Readable/);
			expect(block('wrapped')).toBe(block('plain'));
		});
	}

	it('keeps a typed loader type through the wrapper in the declarations', () => {
		setup({
			'typed.ts': header + `type Item = { id: string };\nexport const feed = live.public(live.stream('typed', async (ctx): Promise<Item[]> => []));\n`,
			'typedplain.ts': header + `type Item = { id: string };\nexport const feed = live.stream('typedp', async (ctx): Promise<Item[]> => []);\n`
		});
		const dts = _generateTypeDeclarations(liveDir, 'src/live');
		const line = (mod) => dts.slice(dts.indexOf(`declare module "$live/${mod}"`)).split('\n').find((l) => /\bfeed\b/.test(l));
		expect(line('typed')).toBe(line('typedplain'));
		expect(line('typed')).toContain('Item');
	});

	it('a live.public RPC stays an RPC', () => {
		setup({ 'rpc.js': `import { live } from 'svelte-realtime/server';\nexport const now = live.public(() => Date.now());\nexport const later = live.public(live.rateLimit({ points: 1, window: 1000 }, async () => 1));\n` });
		const out = code(createPlugin().load('\0live:rpc', { ssr: false }));
		expect(out).toContain('export const now = __rpc("rpc/now")');
		expect(out).toContain('export const later = __rpc("rpc/later")');
	});

	it('live.public around a stream still counts as the module public marker', () => {
		setup({ 'open.js': `import { live } from 'svelte-realtime/server';\nexport const feed = live.public(live.stream('open', async () => []));\nexport const send = live(async () => {});\n` });
		const warns = captureWarns(() => createPlugin().load('\0live:open', { ssr: false }));
		expect(warns.filter((w) => w.includes('_guard'))).toEqual([]);
	});

	for (const wrapper of ['live.gate', 'live.scoped']) {
		for (const kind of [`live.derived(['src'], async () => 1)`, `live.flag('f2', false)`, `live.aggregate('o', { n: { init: () => 0, reduce: (n) => n } }, { topic: 'n2' })`]) {
			it(`${wrapper} around ${kind.slice(0, kind.indexOf('('))} fails the build with a clear message`, () => {
				setup({ 'bad.js': header + `export const feed = ${wrapper}(() => true, ${kind});\n` });
				const plugin = createPlugin();
				expect(() => plugin.load('\0live:bad', { ssr: false })).toThrow(/'feed' wraps live\.\w+\(\) in live\.(gate|scoped)\(\).*Export the live\.\w+\(\) itself/s);
				expect(() => plugin.load('\0live:__registry', { ssr: true })).toThrow(/'feed' wraps/);
			});
		}
	}

	it('ignores wrapped declarations inside comments and strings', () => {
		setup({
			'notes.js': header +
				`// export const old = live.gate(() => true, live.derived(['src'], async () => 1));
` +
				`/* export const older = live.public(live.stream('x', async () => [])); */
` +
				`const doc = "export const quoted = live.scoped(() => true, live.flag('q', 1));";
` +
				`export const feed = live.public(live.stream('notes', async () => []));
`
		});
		const out = code(createPlugin().load('\0live:notes', { ssr: false }));
		expect(out).toContain('export const feed = __stream(');
		// None of them is read as a stream (and the commented gate-around-derived
		// does not fail the build).
		expect(out).not.toMatch(/export const (old|older|quoted) = __stream/);
	});

	it('finds a wrapped export after nested templates and an unterminated quote', () => {
		setup({
			'tricky.js': header +
				"const label = `a ${ \"}\" + `b ${'}'} c` } d`;\n" +
				"const odd = `x ${ { y: `z` }.y }`;\n" +
				"const broken = 'it\n" +
				"export const feed = live.public(live.stream('tricky', async () => []));\n"
		});
		const out = code(createPlugin().load('\0live:tricky', { ssr: false }));
		expect(out).toContain('export const feed = __stream("tricky/feed"');
	});

	for (const [label, eol, quote] of [['CRLF', '\r\n', "'"], ['LF', '\n', "'"], ['CRLF', '\r\n', '"'], ['LF', '\n', '"']]) {
		it(`reads a ${quote}-quoted string continued over a ${label} line break as one string`, () => {
			// If the continuation ended the string, its second line would be
			// read as code, and its backtick would open a template that hides
			// the export below it.
			setup({
				'continued.js': header +
					`const text = ${quote}a\\${eol}b \`${quote};${eol}` +
					`export const feed = live.public(live.stream('continued', async () => []));${eol}`
			});
			const out = code(createPlugin().load('\0live:continued', { ssr: false }));
			expect(out).toContain('export const feed = __stream("continued/feed"');
		});
	}
});
