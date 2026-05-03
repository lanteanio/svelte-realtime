import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
	await page.goto('/lock');
	await page.waitForFunction(() => window.__test);
	await page.evaluate(() => window.__test.reset());
});

// 14 -- live.lock serializes concurrent same-key calls in FIFO order -------

test('live.lock serializes concurrent same-key calls', async ({ page }) => {
	const log = await page.evaluate(() => window.__test.fireThreeOrdered(60));
	expect(log.length).toBe(3);
	expect(new Set(log.map((e) => e.name))).toEqual(new Set(['alpha', 'beta', 'gamma']));

	// FIFO non-overlap invariant: each entry's start time should be at least
	// holdMs (modulo a few ms timer jitter) after the previous one. If the
	// lock did not serialize, we would see overlapping start times.
	for (let i = 1; i < log.length; i++) {
		expect(log[i].t - log[i - 1].t).toBeGreaterThanOrEqual(40);
	}
});

// 15 -- live.lock with maxWaitMs rejects with LOCK_TIMEOUT ------------------

test('live.lock with maxWaitMs rejects waiting caller with LOCK_TIMEOUT', async ({ page }) => {
	const settled = await page.evaluate(() => window.__test.fireBoundedContended(200));
	const errors = settled.filter((s) => !s.ok);
	expect(errors.length).toBeGreaterThanOrEqual(1);
	expect(errors[0].code).toBe('LOCK_TIMEOUT');
});
