import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { mergeConfig } from 'vite';
import realtime from '../src/vite.js';

let root;
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); root = undefined; });
function plugin(command = 'serve', build = {}) {
	root = mkdtempSync(join(tmpdir(), 'realtime-hardening-'));
	mkdirSync(join(root, 'src/live'), { recursive: true });
	writeFileSync(join(root, 'src/live/count.js'), "// realtime-allow-public\nimport { live } from 'svelte-realtime/server';\nexport const count = live(() => 1);\n");
	const p = realtime({ typedImports: false });
	p.configResolved({ root, command, build });
	return p;
}

describe('build environment hardening', () => {
	it.each([{}, { build: {} }])('uses Rolldown metadata before any plugin has introduced build options: %j', config => {
		const p = plugin('build');
		const selected = p.configEnvironment.call({ meta: { rolldownVersion: '1.0.0' } }, 'ssr', config);
		expect(selected.build.rolldownOptions.external.some(value => value.test('svelte-realtime/server'))).toBe(true);
		expect(selected.build.rollupOptions).toBeUndefined();
		const merged = mergeConfig(selected, { build: { rolldownOptions: { output: { format: 'es' } } } });
		expect(merged.build.rolldownOptions.external.some(value => value.test('svelte-realtime/server'))).toBe(true);
		expect(config.build?.rolldownOptions).toBeUndefined();
	});
	it.each([{}, { build: {} }])('uses Rollup when there is no Rolldown metadata: %j', config => {
		const p = plugin('build');
		const selected = p.configEnvironment.call({ meta: { rollupVersion: '4.0.0' } }, 'ssr', config);
		expect(selected.build.rollupOptions.external.some(value => value.test('svelte-realtime/server'))).toBe(true);
		expect(selected.build.rolldownOptions).toBeUndefined();
	});
	it('uses Rollup when Vite calls the hook without a context', () => {
		const p = plugin('build');
		// Vite 6 invokes configEnvironment as a plain function.
		const { configEnvironment } = p;
		const selected = configEnvironment('ssr', {});
		expect(selected.build.rollupOptions.external.some(value => value.test('svelte-realtime/server'))).toBe(true);
		expect(selected.build.rolldownOptions).toBeUndefined();
	});
	it('does not emit a second registry chunk in a Kit 2 SSR build', () => {
		const p = plugin('build', { ssr: true });
		const emitFile = vi.fn();
		p.buildStart.call({ environment: { name: 'ssr' }, emitFile });
		expect(emitFile).not.toHaveBeenCalled();
	});
});

async function htmlResponse(method, html) {
	const p = plugin();
	let middleware;
	p.configureServer({ config: { base: '/nested/' }, httpServer: { once() {} }, watcher: { on() {} },
		middlewares: { use(fn) { middleware = fn; } } });
	const server = createServer((req, res) => middleware(req, res, () => {
		res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(html) });
		res.write(html.slice(0, 15));
		res.end(html.slice(15));
	}));
	await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
	try {
		const response = await fetch('http://127.0.0.1:' + server.address().port, { method });
		return { body: await response.text(), length: response.headers.get('content-length') };
	} finally { await new Promise(resolve => server.close(resolve)); }
}

describe('development HTML response hardening', () => {
	it('injects once before an uppercase split closing tag under a non-root base', async () => {
		const html = '<HTML><HEAD></HEAD><BODY>Gr\u00fc\u00dfe</BODY></HTML>';
		const result = await htmlResponse('GET', html);
		expect(result.body).toBe(html.replace('</HEAD>', '<script type="module" src="/nested/@svelte-realtime-devtools"></script></HEAD>'));
		expect(result.length).toBeNull();
	});
	it('preserves HEAD content length without injecting a response body', async () => {
		const html = '<html><head></head><body>hello</body></html>';
		const result = await htmlResponse('HEAD', html);
		expect(result.body).toBe('');
		expect(result.length).toBe(String(Buffer.byteLength(html)));
	});
});

describe('CLI early Node gate execution', () => {
	it.each(['22.0.0', '22.16.0', '23.5.0'])('rejects Node %s before starting sv or writing a project', version => {
		root = mkdtempSync(join(tmpdir(), 'realtime-node-gate-'));
		const preload = `import child from 'node:child_process'; import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
Object.defineProperty(process.versions, 'node', { value: ${JSON.stringify(version)} });
child.execFileSync = () => { throw new Error('unexpected scaffold subprocess'); };
for (const name of ['writeFileSync', 'mkdirSync', 'rmSync']) fs[name] = () => { throw new Error('unexpected project write'); };
syncBuiltinESMExports();`;
		const result = spawnSync(process.execPath, ['--import', 'data:text/javascript,' + encodeURIComponent(preload), resolve('src/cli.js'), 'new-project', '--yes'], {
			cwd: root, windowsHide: true, encoding: 'utf8', timeout: 5000
		});
		expect(result.error).toBeUndefined();
		expect(result.status).toBe(1);
		expect(result.stderr).toContain('Scaffolding requires Node 22.17+');
		expect(result.stderr).not.toContain('unexpected');
	});
});
