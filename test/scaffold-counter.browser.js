import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { chromium } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { createServer } from 'vite';
import { compile } from 'svelte/compiler';
import { readFileSync } from 'node:fs';
import { browserViewports } from './browser-viewports.js';

let server, browser, context, page, origin;
const errors = [];
beforeAll(async () => {
	const cli = readFileSync(new URL('../src/cli.js', import.meta.url), 'utf8');
	const template = cli.match(/join\(dest, 'src', 'routes', '\+page\.svelte'\),\s*(`[\s\S]*?`)/);
	if (!template) throw new Error('Generated counter template was not found');
	const source = new Function(`return ${template[1]}`)();
	const component = compile(source, { filename: 'generated/+page.svelte', generate: 'client', dev: true });
	expect(component.warnings.filter(w => w.code.startsWith('a11y'))).toEqual([]);
	server = await createServer({
		configFile: false, logLevel: 'silent',
		server: { host: '127.0.0.1', port: 0 },
		optimizeDeps: { noDiscovery: true, include: ['svelte', 'svelte/store', 'svelte/internal/client', 'svelte/internal/disclose-version', 'svelte/internal/flags/legacy'] },
		plugins: [{
			name: 'generated-counter-browser-fixture',
			configureServer(vite) {
				vite.middlewares.use((req, res, next) => {
					if (req.url !== '/') return next();
					res.setHeader('Content-Type', 'text/html');
					res.end('<!doctype html><html lang="en"><head><title>Generated counter</title></head><body><main></main><script type="module" src="/counter-entry.js"></script></body></html>');
				});
			},
			resolveId(id) {
				if (id === '/counter-entry.js' || id === 'virtual:counter-page' || id === '$live/counter') return '\0' + id;
			},
			load(id) {
				if (id === '\0/counter-entry.js') return "import { mount } from 'svelte'; import Page from 'virtual:counter-page'; mount(Page, { target: document.querySelector('main') });";
				if (id === '\0virtual:counter-page') return component.js.code;
				if (id === '\0$live/counter') return `
import { writable, get } from 'svelte/store';
const recovered = sessionStorage.getItem('counter-recovered') === 'yes';
const value = writable(recovered ? 4 : undefined);
const status = writable(recovered ? 'connected' : 'loading');
const error = writable(null);
export const counter = { subscribe: value.subscribe, status, error };
window.counterHarness = {
	incrementCalls: 0,
	set(next, state, failure = null) { value.set(next); status.set(state); error.set(failure); },
	failIncrement: false,
	holdIncrement: false,
	finishIncrement: null,
	recoverOnReload() { sessionStorage.setItem('counter-recovered', 'yes'); }
};
export async function increment() {
	window.counterHarness.incrementCalls++;
	if (window.counterHarness.holdIncrement) await new Promise(resolve => { window.counterHarness.finishIncrement = resolve; });
	if (window.counterHarness.failIncrement) throw new Error('Counter service unavailable');
	value.update(n => (n ?? 0) + 1);
	return get(value);
}`;
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
	await page.getByRole('heading', { name: 'svelte-realtime' }).waitFor();
});
afterAll(async () => {
	await browser?.close();
	await server?.close();
});

it('announces loading, counts and reconnecting through one polite status', async () => {
	const status = page.getByRole('status');
	expect(await status.count()).toBe(1);
	expect(await status.getAttribute('aria-live')).toBe('polite');
	expect(await status.getAttribute('aria-atomic')).toBe('true');
	expect(await status.textContent()).toContain('Connecting');
	const increment = page.getByRole('button', { name: 'Increase count by one', exact: true });
	expect(await increment.isDisabled()).toBe(true);
	await page.evaluate(() => window.counterHarness.set(0, 'connected'));
	await increment.waitFor();
	await increment.focus();
	await page.keyboard.press('Enter');
	await page.waitForFunction(() => document.querySelector('[role="status"]').textContent.includes('Count: 1'));
	expect(await page.evaluate(() => window.counterHarness.incrementCalls)).toBe(1);
	expect(await increment.evaluate(el => el === document.activeElement)).toBe(true);
	await page.evaluate(() => window.counterHarness.set(1, 'reconnecting'));
	await page.waitForFunction(() => document.querySelector('[role="status"]').textContent.includes('Reconnecting'));
	expect(await increment.isDisabled()).toBe(true);
	expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
	expect(errors).toEqual([]);
});

it('exposes connection failure and a keyboard retry that reloads the counter', async () => {
	await page.evaluate(() => window.counterHarness.set(undefined, 'error', { message: 'Access denied' }));
	const retry = page.getByRole('button', { name: 'Retry connection', exact: true });
	expect(await retry.count()).toBe(1);
	await retry.waitFor();
	expect(await page.getByRole('status').textContent()).toContain('Access denied');
	expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
	await page.evaluate(() => window.counterHarness.recoverOnReload());
	await retry.focus();
	await Promise.all([page.waitForEvent('load'), page.keyboard.press('Enter')]);
	await page.waitForFunction(() => document.querySelector('[role="status"]')?.textContent.includes('Count: 4'));
	expect(await page.getByRole('button', { name: 'Increase count by one' }).isEnabled()).toBe(true);
	expect(errors).toEqual([]);
});

it('handles rejected increments and lets the user try again without an unhandled rejection', async () => {
	await page.evaluate(() => { window.counterHarness.set(2, 'connected'); window.counterHarness.failIncrement = true; });
	const increment = page.getByRole('button', { name: 'Increase count by one', exact: true });
	expect(await increment.count()).toBe(1);
	await increment.click();
	await page.waitForFunction(() => document.querySelector('[role="status"]').textContent.includes('Counter service unavailable'));
	expect(await increment.isEnabled()).toBe(true);
	await page.evaluate(() => { window.counterHarness.failIncrement = false; });
	await increment.focus();
	await page.keyboard.press('Space');
	await page.waitForFunction(() => document.querySelector('[role="status"]').textContent.includes('Count: 3'));
	expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
	expect(errors).toEqual([]);
});


it('keeps focus and prevents duplicate increments while a request is pending', async () => {
	await page.evaluate(() => { window.counterHarness.set(0, 'connected'); window.counterHarness.holdIncrement = true; });
	const increment = page.getByRole('button', { name: 'Increase count by one', exact: true });
	await increment.focus();
	await page.keyboard.press('Enter');
	await page.waitForFunction(() => window.counterHarness.finishIncrement !== null);
	expect(await increment.getAttribute('aria-disabled')).toBe('true');
	expect(await increment.evaluate(el => el === document.activeElement)).toBe(true);
	await page.keyboard.press('Enter');
	expect(await page.evaluate(() => window.counterHarness.incrementCalls)).toBe(1);
	await page.evaluate(() => window.counterHarness.finishIncrement());
	await page.waitForFunction(() => document.querySelector('[role="status"]').textContent.includes('Count: 1'));
	expect(await increment.getAttribute('aria-disabled')).toBe('false');
	expect(await increment.evaluate(el => el === document.activeElement)).toBe(true);
});


it.each(browserViewports)('keeps the generated counter usable on $name', async ({ width, height }) => {
	await page.setViewportSize({ width, height });
	await page.evaluate(() => window.counterHarness.set(9, 'connected'));
	const increment = page.getByRole('button', { name: 'Increase count by one', exact: true });
	await increment.click();
	await page.waitForFunction(() => document.querySelector('[role="status"]').textContent.includes('Count: 10'));
	expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
	const box = await increment.boundingBox();
	expect(box.x).toBeGreaterThanOrEqual(0);
	expect(box.x + box.width).toBeLessThanOrEqual(width);
	await page.evaluate(() => window.counterHarness.set(10, 'error', { message: 'Connection unavailable. Try again.' }));
	const retry = page.getByRole('button', { name: 'Retry connection', exact: true });
	await retry.waitFor();
	expect(await page.getByRole('status').textContent()).toContain('Connection unavailable');
	expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
	expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
	expect(errors).toEqual([]);
});
