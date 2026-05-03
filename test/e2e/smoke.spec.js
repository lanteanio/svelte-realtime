import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
	await page.goto('/smoke');
	// Wait for the test API to mount, then reset deterministically: the
	// page exposes window.__test.reset() returning a Promise that settles
	// only after the server publishes the refreshed event AND the client
	// store has been updated to []. Tests call it via page.evaluate so the
	// returned promise is awaited end-to-end.
	await page.waitForFunction(() => window.__test);
	await page.evaluate(() => window.__test.reset());
});

// 11 -- stream subscribe + initial fetch renders ---------------------------

test('stream subscribe + initial fetch renders empty list', async ({ page }) => {
	await expect.poll(async () => {
		const items = await page.$$eval('[data-testid="todos"] li', (els) => els.length);
		return items;
	}, { timeout: 5000 }).toBe(0);
});

// 12 -- RPC roundtrip returns server response ------------------------------

test('echo RPC roundtrip returns server response', async ({ page }) => {
	const r = await page.evaluate(() => window.__test.callEcho('hello'));
	expect(r.received).toEqual({ payload: 'hello' });
	expect(typeof r.at).toBe('number');
});

// 13 -- server publish reflected in subscribed UI --------------------------

test('server publish via RPC reflects in subscribed stream UI', async ({ page }) => {
	const v = await page.evaluate(() => window.__test.publishOne());
	expect(v).toEqual([{ id: 's1', name: 'smoke' }]);
	const items = await page.$$eval('[data-testid="todos"] li', (els) =>
		els.map((el) => ({ id: el.getAttribute('data-id'), name: el.getAttribute('data-name') }))
	);
	expect(items).toEqual([{ id: 's1', name: 'smoke' }]);
});
