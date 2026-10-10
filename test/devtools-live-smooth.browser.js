import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';
import { compileModule } from 'svelte/compiler';
import { createTestServer } from 'svelte-adapter-uws/testing';
import { browserViewports } from './browser-viewports.js';

let server, adapter, browser, context, page, origin;
const errors = [];
beforeAll(async () => {
	adapter = await createTestServer();
	server = await createServer({
		configFile: false, logLevel: 'silent',
		server: { host: '127.0.0.1', port: 0 },
		optimizeDeps: { noDiscovery: true, include: ['svelte/store', 'svelte/internal/client', 'svelte-adapter-uws/client', 'svelte-adapter-uws/plugins/smooth/client'] },
		plugins: [{
			name: 'live-smooth-devtools-browser-fixture',
			configureServer(vite) {
				vite.middlewares.use((req, res, next) => {
					if (req.url !== '/') return next();
					res.setHeader('Content-Type', 'text/html');
					res.end('<!doctype html><html lang="en"><head><title>Smooth inspector</title></head><body><button id="host">Host control</button><script type="module" src="/smooth-entry.js"></script></body></html>');
				});
			},
			resolveId(id) { if (id === '/smooth-entry.js') return '\0' + id; },
			transform(source, id) {
				if (id.endsWith('/src/client-smooth.svelte.js')) return compileModule(source, { filename: id, generate: 'client', dev: true }).js;
			},
			load(id) {
				if (id !== '\0/smooth-entry.js') return;
				return `
import '/src/devtools.js';
import { __devtools } from '/src/client/devtools-instrument.js';
window.__svelte_realtime_devtools = __devtools;
import { SmoothEntity } from '/src/client-smooth.svelte.js';
import { connect, status } from 'svelte-adapter-uws/client';
import { createSmoothChannel } from 'svelte-adapter-uws/plugins/smooth/client';
connect({ url: ${JSON.stringify(adapter.wsUrl)} });
let remoteCount = 1;
const channel = createSmoothChannel({
	initial: { x: 0 }, apply: (state, command) => ({ x: state.x + command.dx }),
	transport: {
		sendCommand() {},
		async sync() {
			return { topic: 'browser-smooth', you: 'self', ack: 0, t: Date.now(), states: [
				{ key: 'self', state: { x: 0 } },
				...Array.from({ length: remoteCount }, (_, n) => ({ key: 'peer-' + n, state: { x: n } }))
			] };
		}
	}
});
const view = new SmoothEntity(channel, status);
window.smoothHarness = {
	view, stats: () => channel.stats(),
	resync(count) { remoteCount = count; channel.resync(); }
};
channel.resync();
`;
			}
		}]
	});
	await server.listen();
	origin = 'http://127.0.0.1:' + server.httpServer.address().port;
	browser = await chromium.launch({ headless: true });
}, 30000);
beforeEach(async () => {
	await context?.close();
	context = await browser.newContext();
	page = await context.newPage();
	errors.length = 0;
	page.on('pageerror', error => errors.push(error.message));
	await page.goto(origin);
	await page.waitForFunction(() => window.smoothHarness?.view.status === 'open' && window.smoothHarness.stats().remoteCount === 1);
});
afterAll(async () => {
	await browser?.close();
	await server?.close();
	await adapter?.close();
});

it.each(browserViewports)('renders and refreshes a live smooth view on $name', async ({ width, height }) => {
	await page.setViewportSize({ width, height });
	const launcher = page.getByRole('button', { name: 'Toggle svelte-realtime DevTools' });
	const panel = page.getByRole('region', { name: 'svelte-realtime DevTools' });
	expect(await panel.isVisible()).toBe(false);
	await launcher.click();
	await page.getByRole('tab', { name: 'smooth', exact: true }).click();
	const content = page.getByRole('tabpanel', { name: 'smooth', exact: true });
	expect(await content.textContent()).toContain('Smoothed channels (1)');
	expect(await content.textContent()).toContain('remote:1');
	await page.evaluate(() => window.smoothHarness.view.command({ dx: 1 }));
	await page.waitForFunction(() => document.querySelector('[role="tabpanel"]')?.textContent.includes('unacked:1/'));
	expect(await page.evaluate(() => window.smoothHarness.stats().unacked)).toBe(1);
	// No tab click or explicit panel render: the normal refresh tick must pull again.
	await page.evaluate(() => window.smoothHarness.resync(3));
	await page.waitForFunction(() => document.querySelector('[role="tabpanel"]')?.textContent.includes('remote:3'));
	expect(await content.textContent()).toContain('unacked:0/');
	const box = await panel.boundingBox();
	expect(box.x).toBeGreaterThanOrEqual(0);
	expect(box.y).toBeGreaterThanOrEqual(0);
	expect(box.x + box.width).toBeLessThanOrEqual(width);
	expect(box.y + box.height).toBeLessThanOrEqual(height);
	await page.evaluate(() => window.smoothHarness.view.destroy());
	await page.waitForFunction(() => document.querySelector('[role="tabpanel"]')?.textContent.includes('Smoothed channels (0)'));
	await page.getByRole('button', { name: 'Close DevTools' }).click();
	expect(await panel.isVisible()).toBe(false);
	expect(errors).toEqual([]);
});
