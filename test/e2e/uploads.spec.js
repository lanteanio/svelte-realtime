// End-to-end tests for live.upload. Each spec runs twice via
// playwright.config.js: once against the Vite dev server (fast, exercises
// the codegen pre-warm path) and once against the built production server
// (slow, exercises the adapter packaging + bundled ws-handler). Both
// must round-trip the same bytes for live.upload to be considered shipped.

import { test, expect } from '@playwright/test';

let frames;
test.beforeEach(async ({ page }) => {
	frames = [];
	page.on('websocket', socket => socket.on('framesent', ({ payload }) => {
		if (Buffer.isBuffer(payload) && payload[0] === 0x01) frames.push(payload);
	}));
	await page.goto('/uploads');
	await page.waitForFunction(() => window.__test);
});

test('single-chunk upload round-trips byte count and args', async ({ page }) => {
	const r = await page.evaluate(() => window.__test.singleChunk(64));
	expect(r).toMatchObject({ label: 'single', bytes: 64, chunks: 1 });
	expect(r.firstByte).toBe(1);
	expect(r.lastByte).toBe(64);
});

test('multi-chunk upload with an envelope-derived frame cap sends sequential frames', async ({ page }) => {
	// Derive the cap from the actual RPC envelope plus one payload byte.
	const r = await page.evaluate(() => window.__test.multiChunk(20, 1));
	expect(r).toMatchObject({ label: 'multi', bytes: 20, chunks: 20 });
	expect(r.firstByte).toBe(1);
	expect(r.lastByte).toBe(20);
	expect(frames).toHaveLength(20);
	expect(frames.every(frame => frame.length <= r.frameSize)).toBe(true);
	// The page derives the cap from the credit-mode chunk 0 header.
	const headerLength = frames[0].readUInt16BE(10);
	expect(Object.keys(JSON.parse(frames[0].subarray(12, 12 + headerLength).toString()))).toContain('path');
});

test('cancel mid-upload rejects with CANCELLED on the client', async ({ page }) => {
	const r = await page.evaluate(() => window.__test.cancelMidUpload());
	expect(r.ok).toBe(false);
	expect(r.code).toBe('CANCELLED');
});

test('progress events fire with monotonically increasing sent counts', async ({ page }) => {
	// A valid envelope-derived cap leaves one payload byte per frame.
	const r = await page.evaluate(() => window.__test.peekProgress(64, 1));
	expect(r.result.bytes).toBe(64);
	expect(r.events.length).toBeGreaterThanOrEqual(8);
	expect(frames).toHaveLength(64);
	expect(frames.every(frame => frame.length <= r.frameSize)).toBe(true);
	// Sent counts should be strictly increasing
	for (let i = 1; i < r.events.length; i++) {
		expect(r.events[i].sent).toBeGreaterThan(r.events[i - 1].sent);
	}
	// Last event should report the full byte count
	expect(r.events[r.events.length - 1].sent).toBe(64);
});
