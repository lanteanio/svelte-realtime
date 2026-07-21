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
	// `chunkSize` (deprecated alias of `frameSize`) caps the WIRE FRAME, and
	// the per-chunk payload is frame minus the 12-byte chunk header and the
	// args JSON - clamped to at least 1 byte. A 4-byte frame budget cannot
	// carry even the header, so the payload degrades to 1 byte per frame:
	// 20 bytes ride 20 sequential frames, reassembled in order server-side.
	expect(r).toMatchObject({ label: 'multi', bytes: 20, chunks: 20 });
	expect(r.firstByte).toBe(1);
	expect(r.lastByte).toBe(20);
});

test('cancel mid-upload rejects with CANCELLED on the client', async ({ page }) => {
	const r = await page.evaluate(() => window.__test.cancelMidUpload());
	expect(r.ok).toBe(false);
	expect(r.code).toBe('CANCELLED');
});

test('progress events fire with monotonically increasing sent counts', async ({ page }) => {
	// chunkSize=8 caps the WIRE FRAME below the 12-byte chunk header, so the
	// per-frame payload clamps to 1 byte: 64 bytes ride 64 frames, giving at
	// least 8 progress events (the assertion below is a floor, not a count).
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
