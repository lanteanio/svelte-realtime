import { afterAll, beforeAll, expect, it } from 'vitest';
import { chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

let server, browser, origin;
const bundles = new Map();
const modes = [
	['development', { DEV: true, PROD: false }, true],
	['production', { DEV: false, PROD: true }, false],
	['conflicting', { DEV: true, PROD: true }, false],
	['unspecified', {}, false]
];

beforeAll(async () => {
	for (const [name, env] of modes) {
		const result = await build({
			configFile: false, logLevel: 'silent',
			define: {
				'import.meta.env.DEV': JSON.stringify(env.DEV) ?? 'undefined',
				'import.meta.env.PROD': JSON.stringify(env.PROD) ?? 'undefined'
			},
			build: { write: false, lib: { entry: fileURLToPath(new URL('../src/devtools.js', import.meta.url)), formats: ['es'], fileName: 'overlay' } }
		});
		bundles.set('/' + name + '.js', (Array.isArray(result) ? result[0] : result).output[0].code);
	}
	server = createServer(async (req, res) => {
		const url = new URL(req.url, 'http://localhost');
		if (url.pathname === '/') {
			const mode = url.searchParams.get('mode');
			const entry = mode === 'raw' ? '/src/devtools.js' : '/' + mode + '.js';
			res.setHeader('Content-Type', 'text/html');
			res.end('<!doctype html><html lang="en"><head><title>Overlay environment</title></head><body><script type="module">import { configureDevtools } from ' + JSON.stringify(entry) + '; configureDevtools({ locale: "de" }); window.overlayLoaded = true;</script></body></html>');
			return;
		}
		if (bundles.has(url.pathname)) {
			res.setHeader('Content-Type', 'text/javascript');
			res.end(bundles.get(url.pathname));
			return;
		}
		if (['/src/devtools.js', '/src/client-runtime.js'].includes(url.pathname)) {
			try {
				res.setHeader('Content-Type', 'text/javascript');
				res.end(await readFile(new URL('..' + url.pathname, import.meta.url)));
			} catch { res.writeHead(500).end(); }
			return;
		}
		res.writeHead(404).end();
	});
	await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
	origin = 'http://127.0.0.1:' + server.address().port;
	browser = await chromium.launch({ headless: true });
}, 30000);

afterAll(async () => {
	await browser?.close();
	if (server) await new Promise(resolve => server.close(resolve));
});

it.each([...modes.map(([name, , enabled]) => [name, enabled]), ['raw', false]])('mounts the imported overlay only in explicit development: %s', async (mode, enabled) => {
	const page = await browser.newPage();
	const errors = [];
	page.on('pageerror', error => errors.push(error.message));
	try {
		await page.addInitScript(() => {
			window.overlayKeyListeners = 0;
			const add = document.addEventListener;
			document.addEventListener = function(type, ...args) {
				if (type === 'keydown') window.overlayKeyListeners++;
				return add.call(this, type, ...args);
			};
		});
		await page.goto(origin + '/?mode=' + mode);
		await page.waitForFunction(() => window.overlayLoaded === true);
		expect(errors).toEqual([]);
		expect(await page.locator('#svr-dt-launcher').count()).toBe(enabled ? 1 : 0);
		expect(await page.locator('#svelte-realtime-devtools').count()).toBe(enabled ? 1 : 0);
		expect(await page.evaluate(() => window.overlayKeyListeners)).toBe(enabled ? 1 : 0);
		expect(await page.evaluate(() => {
			const event = new KeyboardEvent('keydown', { key: 'L', ctrlKey: true, shiftKey: true, cancelable: true });
			document.dispatchEvent(event);
			return event.defaultPrevented;
		})).toBe(enabled);
		if (enabled) expect(await page.locator('#svelte-realtime-devtools').isVisible()).toBe(true);
	} finally { await page.close(); }
}, 30000);
