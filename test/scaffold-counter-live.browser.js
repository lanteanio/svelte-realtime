import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { chromium } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { createServer } from 'vite';
import { compile } from 'svelte/compiler';
import { createTestServer } from 'svelte-adapter-uws/testing';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import svelteRealtime from '../src/vite.js';
import { browserViewports } from './browser-viewports.js';

// The scaffolder's own counter module and page, compiled by the real Vite plugin
// and served by a real adapter: every count below crosses the RPC and stream wire.
const cli = readFileSync(new URL('../src/cli.js', import.meta.url), 'utf8');
function scaffoldTemplate(path) {
	const escaped = path.map(part => part.replace(/[.+]/g, '\\$&')).join("', '");
	const match = cli.match(new RegExp(`join\\(dest, '${escaped}'\\),\\s*(\`[\\s\\S]*?\`)`));
	if (!match) throw new Error('Scaffold template not found: ' + path.join('/'));
	return new Function(`return ${match[1]}`)();
}

let vite, adapter, browser, context, page, origin, liveDir;
const errors = [];
beforeAll(async () => {
	liveDir = mkdtempSync(join(tmpdir(), 'realtime-counter-live-'));
	writeFileSync(join(liveDir, 'counter.ts'), scaffoldTemplate(['src', 'live', 'counter.ts']));
	const compiled = compile(scaffoldTemplate(['src', 'routes', '+page.svelte']), { filename: 'generated/+page.svelte', generate: 'client', dev: true });
	const source = (path) => fileURLToPath(new URL('../src/' + path, import.meta.url));
	vite = await createServer({
		configFile: false, logLevel: 'silent',
		root: fileURLToPath(new URL('..', import.meta.url)),
		server: { host: '127.0.0.1', port: 0 },
		resolve: { alias: [
			{ find: /^svelte-realtime\/server$/, replacement: source('server.js') },
			{ find: /^svelte-realtime\/client$/, replacement: source('client.js') }
		] },
		optimizeDeps: { noDiscovery: true, include: ['svelte', 'svelte/store', 'svelte/internal/client', 'svelte/internal/disclose-version', 'svelte/internal/flags/legacy', 'svelte-adapter-uws/client'] },
		plugins: [svelteRealtime({ dir: liveDir, devtools: false, typedImports: false }), {
			name: 'generated-counter-live-fixture',
			configureServer(server) {
				server.middlewares.use((req, res, next) => {
					if (req.url !== '/') return next();
					res.setHeader('Content-Type', 'text/html');
					res.end('<!doctype html><html lang="en"><head><title>Generated counter</title></head><body><main></main><script type="module" src="/counter-entry.js"></script></body></html>');
				});
			},
			resolveId(id) {
				if (id === '/counter-entry.js' || id === 'virtual:counter-page') return '\0' + id;
			},
			load(id) {
				if (id === '\0/counter-entry.js') {
					return `import { configure } from 'svelte-realtime/client';
configure({ url: ${JSON.stringify(adapter.wsUrl)} });
const { mount } = await import('svelte');
const { default: Page } = await import('virtual:counter-page');
mount(Page, { target: document.querySelector('main') });`;
				}
				if (id === '\0virtual:counter-page') return compiled.js.code;
			}
		}]
	});
	// The handler and the generated registry share one server module instance.
	const server = await vite.ssrLoadModule('svelte-realtime/server');
	await vite.ssrLoadModule('/@svelte-realtime-registry');
	adapter = await createTestServer({ handler: server.realtime() });
	await vite.listen();
	origin = 'http://127.0.0.1:' + vite.httpServer.address().port;
	browser = await chromium.launch({ headless: true });
}, 60000);
beforeEach(async () => {
	await context?.close();
	context = await browser.newContext();
	page = await context.newPage();
	errors.length = 0;
	page.on('pageerror', error => errors.push(error.message));
});
afterAll(async () => {
	await browser?.close();
	await vite?.close();
	await adapter?.close();
	if (liveDir) rmSync(liveDir, { recursive: true, force: true });
});

const countOf = (target) => target.waitForFunction(() => {
	const match = /Count: (\d+)/.exec(document.querySelector('[role="status"]')?.textContent ?? '');
	// Wrapped, because a count of 0 is falsy and would keep the wait polling.
	return match && { count: Number(match[1]) };
}).then(handle => handle.jsonValue()).then(value => value.count);

it.each(browserViewports)('counts through the generated live module on $name', async ({ width, height }) => {
	await page.setViewportSize({ width, height });
	await page.goto(origin);
	const before = await countOf(page);
	const observer = await context.newPage();
	await observer.goto(origin);
	expect(await countOf(observer)).toBe(before);

	const increment = page.getByRole('button', { name: 'Increase count by one', exact: true });
	await increment.click();
	const expected = `Count: ${before + 1}`;
	await page.waitForFunction(text => document.querySelector('[role="status"]').textContent.includes(text), expected);
	// The second tab receives the server's published count, not a local update.
	await observer.waitForFunction(text => document.querySelector('[role="status"]').textContent.includes(text), expected);

	expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
	const box = await increment.boundingBox();
	expect(box.x).toBeGreaterThanOrEqual(0);
	expect(box.x + box.width).toBeLessThanOrEqual(width);
	expect(await increment.isEnabled()).toBe(true);
	expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
	await observer.close();
	expect(errors).toEqual([]);
}, 30000);
