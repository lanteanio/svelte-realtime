import { test, expect } from '@playwright/test';
import { DEV_PORT, PROD_PORT } from './ports.js';

// Cron e2e: proves `live.cron(...)` server-side scheduled functions
// publish to topics correctly across one or more connected clients.
//
// Determinism: the schedule '* * * * *' matches every minute, but we
// never wait for the clock. The fixture exposes a `tickNow` RPC that
// imports `_tickCron` from 'svelte-realtime/server' and triggers the
// matching jobs synchronously, so each test fires the cron exactly
// when it wants to.

async function openCron(browser, baseURL, identity) {
	const url = new URL(baseURL);
	const ctx = await browser.newContext();
	await ctx.addCookies([{ name: 'user', value: identity, domain: url.hostname, path: '/' }]);
	const page = await ctx.newPage();
	await page.goto('/cron');
	await page.waitForFunction(() => window.__test);
	await page.evaluate(() => window.__test.ready());
	return { ctx, page };
}

function baseURLFromProject(testInfo) {
	const isProd = testInfo.project.name.endsWith('-prod');
	return 'http://localhost:' + (isProd ? PROD_PORT : DEV_PORT);
}

test.beforeEach(async ({ page }) => {
	await page.goto('/cron');
	await page.waitForFunction(() => window.__test);
	await page.evaluate(() => window.__test.reset());
});

// 1 -- Auto-publish via return value: cron returns an object and the
// framework publishes a `set` event the merge-set stream picks up.

test('auto-publish: cron return value lands as a `set` event', async ({ page }) => {
	await page.evaluate(() => window.__test.tickNow());
	await page.evaluate(() =>
		window.__test.waitStats('(v) => v && v.tickCount === 1 && typeof v.ts === "number"')
	);
	const stats = await page.evaluate(() => window.__test.readStats());
	expect(stats).not.toBeNull();
	expect(stats.tickCount).toBe(1);
	expect(typeof stats.ts).toBe('number');

	// Tick again -- counter increments and the set event replaces.
	await page.evaluate(() => window.__test.tickNow());
	await page.evaluate(() => window.__test.waitStats('(v) => v && v.tickCount === 2'));
	const counts = await page.evaluate(() => window.__test.getCounts());
	expect(counts.ticks).toBe(2);
});

// 2 -- Manual ctx.publish inside the cron: cron returns undefined and
// fires individual `created` events on a crud stream.

test('manual ctx.publish: crud stream sees per-tick created events', async ({ page }) => {
	await page.evaluate(() => window.__test.tickNow());
	await page.evaluate(() => window.__test.waitFeedCount(1));
	await page.evaluate(() => window.__test.tickNow());
	await page.evaluate(() => window.__test.waitFeedCount(2));
	await page.evaluate(() => window.__test.tickNow());
	await page.evaluate(() => window.__test.waitFeedCount(3));

	const feed = await page.evaluate(() => window.__test.readFeed());
	const ids = feed.map((x) => x.id).sort();
	expect(ids).toEqual(['i1', 'i2', 'i3']);
	const labels = feed.slice().sort((a, b) => a.id.localeCompare(b.id)).map((x) => x.label);
	expect(labels).toEqual(['cron-1', 'cron-2', 'cron-3']);

	const counts = await page.evaluate(() => window.__test.getCounts());
	expect(counts.itemCount).toBe(3);
});

// 3 -- Multi-client fan-out: A and B both subscribe to stats; one tick
// fans out to both clients with the same value.

test('multi-client: stats publish fans out to A and B', async ({ browser }, testInfo) => {
	const baseURL = baseURLFromProject(testInfo);
	const a = await openCron(browser, baseURL, 'alice');
	const b = await openCron(browser, baseURL, 'bob');
	try {
		await a.page.evaluate(() => window.__test.reset());
		await b.page.evaluate(() => window.__test.waitStats('(v) => v === null'));
		await a.page.evaluate(() => window.__test.tickNow());
		await a.page.evaluate(() => window.__test.waitStats('(v) => v && v.tickCount === 1'));
		await b.page.evaluate(() => window.__test.waitStats('(v) => v && v.tickCount === 1'));

		const sa = await a.page.evaluate(() => window.__test.readStats());
		const sb = await b.page.evaluate(() => window.__test.readStats());
		expect(sa.tickCount).toBe(sb.tickCount);
		expect(sa.ts).toBe(sb.ts);
	} finally {
		await a.ctx.close();
		await b.ctx.close();
	}
});

// 4 -- Late join: cron fires twice, then C subscribes; C's initial
// loader fetch returns the latest `_lastStats` value (the loader reads
// the value the cron stored), proving the cron's state is observable
// to fresh subscribers.

test('late join: C subscribes after ticks; initial fetch returns latest stats', async ({ browser }, testInfo) => {
	const baseURL = baseURLFromProject(testInfo);
	const a = await openCron(browser, baseURL, 'alice');
	try {
		await a.page.evaluate(() => window.__test.reset());
		await a.page.evaluate(() => window.__test.tickNow());
		await a.page.evaluate(() => window.__test.tickNow());
		await a.page.evaluate(() => window.__test.waitStats('(v) => v && v.tickCount === 2'));

		const c = await openCron(browser, baseURL, 'carol');
		try {
			// C's loader returns _lastStats which was set to tickCount=2 by
			// the cron runs above. The initial fetch resolves with that.
			await c.page.evaluate(() => window.__test.waitStats('(v) => v && v.tickCount === 2'));
			const stats = await c.page.evaluate(() => window.__test.readStats());
			expect(stats.tickCount).toBe(2);
		} finally {
			await c.ctx.close();
		}
	} finally {
		await a.ctx.close();
	}
});

// 5 -- Sanity: cron is independent of pubsub. Publishing to an unrelated
// topic does not advance the cron's internal counters. (We don't have a
// publishExternal RPC on this fixture, so we assert the inverse: ticks
// only advance via tickNow, never as a side effect of resetCron's
// publishes.)

test('sanity: cron does not fire on unrelated publishes', async ({ page }) => {
	const before = await page.evaluate(() => window.__test.getCounts());
	expect(before.ticks).toBe(0);
	expect(before.itemCount).toBe(0);

	// reset publishes refreshed:[] on feed and set:null on stats. These
	// are pubsub frames; they must NOT advance the cron counters.
	await page.evaluate(() => window.__test.reset());
	const afterReset = await page.evaluate(() => window.__test.getCounts());
	expect(afterReset.ticks).toBe(0);
	expect(afterReset.itemCount).toBe(0);

	// One tickNow -> exactly one of each cron fires.
	await page.evaluate(() => window.__test.tickNow());
	await page.evaluate(() => window.__test.waitFeedCount(1));
	const afterTick = await page.evaluate(() => window.__test.getCounts());
	expect(afterTick.ticks).toBe(1);
	expect(afterTick.itemCount).toBe(1);
});
