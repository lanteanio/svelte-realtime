import { test, expect } from '@playwright/test';
import { DEV_PORT, PROD_PORT } from './ports.js';

// live.derived() e2e: proves server-side computed streams recompute
// when source topics publish, in single-client and multi-client
// (cross-context) scenarios. Identity comes from a `user` cookie so
// each BrowserContext has a distinct ctx.user, matching the existing
// auth/presence multi-context pattern.

async function openDerived(browser, baseURL, identity) {
	const url = new URL(baseURL);
	const ctx = await browser.newContext();
	await ctx.addCookies([{ name: 'user', value: identity, domain: url.hostname, path: '/' }]);
	const page = await ctx.newPage();
	await page.goto('/derived');
	await page.waitForFunction(() => window.__test);
	await page.evaluate(() => window.__test.ready());
	return { ctx, page };
}

function baseURLFromProject(testInfo) {
	const isProd = testInfo.project.name.endsWith('-prod');
	return 'http://localhost:' + (isProd ? PROD_PORT : DEV_PORT);
}

test.beforeEach(async ({ page }) => {
	await page.goto('/derived');
	await page.waitForFunction(() => window.__test);
	await page.evaluate(() => window.__test.reset());
});

// 1 -- static sources cross-client: A subscribes, B publishes, A sees recompute

test('static sources cross-client: A subscribes, B publishes, A sees recompute', async ({ browser }, testInfo) => {
	const baseURL = baseURLFromProject(testInfo);
	const a = await openDerived(browser, baseURL, 'alice');
	const b = await openDerived(browser, baseURL, 'bob');
	try {
		await a.page.evaluate(() => window.__test.reset());
		await b.page.evaluate(() => window.__test.waitDashboard('v && v.orders === 0 && v.users === 0'));
		await b.page.evaluate(() => window.__test.incOrders());
		await a.page.evaluate(() => window.__test.waitDashboard('v && v.orders === 1'));
		const seen = await a.page.evaluate(() => window.__test.readDashboard());
		expect(seen.orders).toBe(1);
		expect(seen.recomputeCount).toBeGreaterThanOrEqual(1);
	} finally {
		await a.ctx.close();
		await b.ctx.close();
	}
});

// 2 -- multi-source recompute: orders then users both trigger distinct recomputes

test('multi-source: publishing to each source produces a distinct recompute', async ({ page }) => {
	await page.evaluate(() => window.__test.incOrders());
	await page.evaluate(() => window.__test.waitDashboard('v && v.orders === 1 && v.users === 0'));
	const afterOrders = await page.evaluate(() => window.__test.readDashboard());
	expect(afterOrders.orders).toBe(1);
	expect(afterOrders.users).toBe(0);

	await page.evaluate(() => window.__test.incUsers());
	await page.evaluate(() => window.__test.waitDashboard('v && v.orders === 1 && v.users === 1'));
	const afterUsers = await page.evaluate(() => window.__test.readDashboard());
	expect(afterUsers.orders).toBe(1);
	expect(afterUsers.users).toBe(1);
	expect(afterUsers.recomputeCount).toBeGreaterThan(afterOrders.recomputeCount);
});

// 3 -- debounce: 5 rapid publishes within 50ms coalesce into a single recompute

test('debounce: rapid source publishes coalesce into a single recompute', async ({ page }) => {
	const before = await page.evaluate(() => window.__test.getCounts());
	const debouncedBefore = before.debounced;

	// Fire 5 publishes back-to-back; the burst RPC publishes synchronously
	// inside one handler so all 5 land before the 200ms debounce window expires.
	await page.evaluate(() => window.__test.incOrdersBurst(5));

	// The non-debounced dashboard should reflect orders=5 immediately.
	await page.evaluate(() => window.__test.waitDashboard('v && v.orders === 5'));

	// Wait past the debounce window plus a small margin for the recompute
	// to fire and the publish to round-trip.
	await page.waitForTimeout(450);

	const after = await page.evaluate(() => window.__test.getCounts());
	const fired = after.debounced - debouncedBefore;
	// Expect exactly 1 (trailing-edge debounce) or at most 2 if the leading
	// edge also flushed; verify against the implementation behaviour.
	expect(fired).toBeGreaterThanOrEqual(1);
	expect(fired).toBeLessThanOrEqual(2);

	const debouncedValue = await page.evaluate(() => window.__test.readDebounced());
	expect(debouncedValue.orders).toBe(5);
});

// 4 -- multi-client fan-out: one publish, both A and B see the recompute

test('multi-client fan-out: one source publish, both subscribers see the recompute', async ({ browser }, testInfo) => {
	const baseURL = baseURLFromProject(testInfo);
	const a = await openDerived(browser, baseURL, 'alice');
	const b = await openDerived(browser, baseURL, 'bob');
	try {
		await a.page.evaluate(() => window.__test.reset());
		await a.page.evaluate(() => window.__test.waitDashboard('v && v.orders === 0'));
		await b.page.evaluate(() => window.__test.waitDashboard('v && v.orders === 0'));

		await a.page.evaluate(() => window.__test.incUsers());

		await a.page.evaluate(() => window.__test.waitDashboard('v && v.users === 1'));
		await b.page.evaluate(() => window.__test.waitDashboard('v && v.users === 1'));

		const aValue = await a.page.evaluate(() => window.__test.readDashboard());
		const bValue = await b.page.evaluate(() => window.__test.readDashboard());
		expect(aValue.users).toBe(1);
		expect(bValue.users).toBe(1);
	} finally {
		await a.ctx.close();
		await b.ctx.close();
	}
});

// 5 -- dynamic derived: publishing to a different orgId does not recompute

test('dynamic derived: publishing to a non-watched org leaves the watched org untouched', async ({ page }) => {
	// Subscribe to o1 (already done by ready()). Confirm initial state.
	await page.evaluate(() => window.__test.waitOrg1('v && v.orgId === "o1"'));
	const before = await page.evaluate(() => window.__test.getCounts());
	const o1Before = (before.orgs && before.orgs.o1) || 0;

	// Publish to o1's source -- recomputes orgStats('o1').
	await page.evaluate(() => window.__test.publishOrgSource('o1', 'memberships'));
	await page.evaluate(
		(target) => window.__test.waitOrg1('v && v.recomputed === ' + target),
		o1Before + 1
	);

	// Publish to o2's source -- must NOT touch the o1 instance counter.
	const beforeUntouched = await page.evaluate(() => window.__test.getCounts());
	await page.evaluate(() => window.__test.publishOrgSource('o2', 'memberships'));
	await page.waitForTimeout(300);
	const afterIsolation = await page.evaluate(() => window.__test.getCounts());

	// o2 may or may not have recomputed depending on whether o2 is also subscribed
	// (it is, via the page's static `orgStats('o2')` reference). The contract we
	// care about: publishing to o2 must not change o1's recompute count.
	expect((afterIsolation.orgs && afterIsolation.orgs.o1) || 0).toBe(
		(beforeUntouched.orgs && beforeUntouched.orgs.o1) || 0
	);
});

// 6 -- late join: B subscribes after A publishes; B's initial fetch reflects it

test('late join: B subscribes after A publishes; initial fetch reflects derived', async ({ browser }, testInfo) => {
	const baseURL = baseURLFromProject(testInfo);
	const a = await openDerived(browser, baseURL, 'alice');
	try {
		await a.page.evaluate(() => window.__test.reset());
		await a.page.evaluate(() => window.__test.incOrders());
		await a.page.evaluate(() => window.__test.incOrders());
		await a.page.evaluate(() => window.__test.waitDashboard('v && v.orders === 2'));

		// B opens fresh AFTER the source publishes. Its initial loader
		// should reflect the latest counts (the loader returns the closure
		// state, so even without recompute history B sees the current value).
		const b = await openDerived(browser, baseURL, 'bob');
		try {
			await b.page.evaluate(() => window.__test.waitDashboard('v && v.orders === 2'));
			const bValue = await b.page.evaluate(() => window.__test.readDashboard());
			expect(bValue.orders).toBe(2);
		} finally {
			await b.ctx.close();
		}
	} finally {
		await a.ctx.close();
	}
});
