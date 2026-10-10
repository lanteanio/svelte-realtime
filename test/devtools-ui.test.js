import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';

let server, browser, page, origin;
beforeAll(async () => {
	server = createServer(async (req, res) => {
		if (req.url === '/') {
			res.setHeader('Content-Type', 'text/html');
			res.end('<button id="host">Host control</button><script type="module" src="/src/devtools.js"></script>');
			return;
		}
		if (!/^\/src\/[a-z/-]+\.js$/.test(req.url)) { res.writeHead(404).end(); return; }
		try {
			const body = await readFile(new URL('..' + req.url, import.meta.url));
			res.setHeader('Content-Type', 'text/javascript');
			res.end(body);
		} catch { res.writeHead(404).end(); }
	});
	await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
	origin = 'http://127.0.0.1:' + server.address().port;
	browser = await chromium.launch({ headless: true });
}, 30000);
beforeEach(async () => {
	await page?.close();
	page = await browser.newPage();
	await page.goto(origin);
	await page.getByRole('button', { name: 'Toggle svelte-realtime DevTools' }).waitFor();
});
afterAll(async () => {
	await browser?.close();
	if (server) await new Promise(resolve => server.close(resolve));
});
describe('DevTools focus', () => {
	it('opens a named non-modal region and restores focus through close and Escape', async () => {
		await page.locator('#host').focus();
		await page.keyboard.press('Control+Shift+L');
		const region = page.getByRole('region', { name: 'svelte-realtime DevTools' });
		expect(await region.isVisible()).toBe(true);
		expect(await page.getByRole('button', { name: 'Close DevTools' }).evaluate(el => el === document.activeElement)).toBe(true);
		await page.keyboard.press('Escape');
		expect(await region.isVisible()).toBe(false);
		expect(await page.locator('#host').evaluate(el => el === document.activeElement)).toBe(true);
		const launcher = page.getByRole('button', { name: 'Toggle svelte-realtime DevTools' });
		await launcher.click();
		expect(await launcher.getAttribute('aria-expanded')).toBe('true');
		await page.getByRole('button', { name: 'Close DevTools' }).click();
		expect(await launcher.evaluate(el => el === document.activeElement)).toBe(true);
		expect(await launcher.getAttribute('aria-expanded')).toBe('false');
	});
});
async function streamsFixture() {
 await page.evaluate(() => { window.__svelte_realtime_devtools = { pending: new Map(), history: [], streams: new Map([['chat', { path: 'chat', topic: 'chat', subCount: 1, recentEvents: [], lastEventTime: Date.now(), lastEvent: 'update' }]]) }; });
 await page.getByRole('button', { name: 'Toggle svelte-realtime DevTools' }).click();
}
it('provides roving tabs and keyboard stream expansion with readable toggle states', async () => {
 await streamsFixture();
 const rpcs = page.getByRole('tab', { name: 'rpcs', exact: true });
 await rpcs.focus();
 await page.keyboard.press('ArrowRight');
 const streams = page.getByRole('tab', { name: 'streams', exact: true });
 expect(await streams.getAttribute('aria-selected')).toBe('true');
 expect(await rpcs.getAttribute('tabindex')).toBe('-1');
 expect(await page.getByRole('tabpanel', { name: 'streams' }).count()).toBe(1);
 const expand = page.locator('[data-action="toggle-stream"]');
 await expand.focus();
 await page.keyboard.press('Enter');
 expect(await expand.getAttribute('aria-expanded')).toBe('true');
 expect(await page.locator('[id="' + await expand.getAttribute('aria-controls') + '"]').isVisible()).toBe(true);
 const pause = page.getByRole('button', { name: 'Pause event capture' });
 expect(await pause.getAttribute('aria-pressed')).toBe('false');
 await pause.click();
 expect(await pause.getAttribute('aria-pressed')).toBe('true');
 await streams.focus();
 await page.keyboard.press('End');
 expect(await page.getByRole('tab', { name: 'connection', exact: true }).getAttribute('aria-selected')).toBe('true');
 await page.keyboard.press('Home');
 expect(await rpcs.getAttribute('aria-selected')).toBe('true');
});
