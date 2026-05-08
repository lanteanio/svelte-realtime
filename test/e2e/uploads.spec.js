// End-to-end tests for live.upload. Each spec runs twice via
// playwright.config.js: once against the Vite dev server (fast, exercises
// the codegen pre-warm path) and once against the built production server
// (slow, exercises the adapter packaging + bundled ws-handler). Both
// must round-trip the same bytes for live.upload to be considered shipped.

import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
	await page.goto('/uploads');
	await page.waitForFunction(() => window.__test);
});

test('single-chunk upload round-trips byte count and args', async ({ page }) => {
	const r = await page.evaluate(() => window.__test.singleChunk(64));
	expect(r).toMatchObject({ label: 'single', bytes: 64, chunks: 1 });
	expect(r.firstByte).toBe(1);
	expect(r.lastByte).toBe(64);
});

test('multi-chunk upload with explicit small chunkSize sends sequential frames', async ({ page }) => {
	const r = await page.evaluate(() => window.__test.multiChunk(20, 4));
	// 20 bytes / 4-byte chunks = 5 chunks
	expect(r).toMatchObject({ label: 'multi', bytes: 20, chunks: 5 });
	expect(r.firstByte).toBe(1);
	expect(r.lastByte).toBe(20);
});

test('cancel mid-upload rejects with CANCELLED on the client', async ({ page }) => {
	const r = await page.evaluate(() => window.__test.cancelMidUpload());
	expect(r.ok).toBe(false);
	expect(r.code).toBe('CANCELLED');
});

test('progress events fire with monotonically increasing sent counts', async ({ page }) => {
	// Force chunkSize=8 so a 64-byte payload produces 8 progress events
	const r = await page.evaluate(() => window.__test.peekProgress(64, 8));
	expect(r.result.bytes).toBe(64);
	expect(r.events.length).toBeGreaterThanOrEqual(8);
	// Sent counts should be strictly increasing
	for (let i = 1; i < r.events.length; i++) {
		expect(r.events[i].sent).toBeGreaterThan(r.events[i - 1].sent);
	}
	// Last event should report the full byte count
	expect(r.events[r.events.length - 1].sent).toBe(64);
});
