import { test, expect } from '@playwright/test';
import { DEV_PORT, PROD_PORT } from './ports.js';

// Presence merge-strategy e2e: proves `merge: 'presence'` join/leave
// events round-trip across multiple connected clients. Each
// BrowserContext sets a distinct `user` cookie so the WS upgrade
// hook reads a different identity per page (re-using the auth
// fixture's hooks.ws.js cookie path).

async function openPresence(browser, baseURL, identity) {
	const url = new URL(baseURL);
	const ctx = await browser.newContext();
	await ctx.addCookies([{ name: 'user', value: identity, domain: url.hostname, path: '/' }]);
	const page = await ctx.newPage();
	await page.goto('/presence');
	await page.waitForFunction(() => window.__test);
	await page.evaluate(() => window.__test.ready());
	return { ctx, page };
}

function baseURLFromProject(testInfo) {
	const isProd = testInfo.project.name.endsWith('-prod');
	return 'http://localhost:' + (isProd ? PROD_PORT : DEV_PORT);
}

test.beforeEach(async ({ page }) => {
	await page.goto('/presence');
	await page.waitForFunction(() => window.__test);
	await page.evaluate(() => window.__test.reset());
});

// 1 -- single client join then leave -------------------------------------

test('single client: join then leave updates the roster', async ({ page }) => {
	await page.evaluate(() => window.__test.join('Alpha'));
	await page.evaluate(() => window.__test.waitRoster([{ key: 'e2e-user', name: 'Alpha' }]));
	await page.evaluate(() => window.__test.leave());
	await page.evaluate(() => window.__test.waitRoster([]));
});

// 2 -- A joins, B sees A in the roster (cross-client visibility) --------

test('cross-client: A joins, B sees A in the roster', async ({ browser }, testInfo) => {
	const baseURL = baseURLFromProject(testInfo);
	const a = await openPresence(browser, baseURL, 'alice');
	const b = await openPresence(browser, baseURL, 'bob');
	try {
		await a.page.evaluate(() => window.__test.reset());
		await b.page.evaluate(() => window.__test.waitRoster([]));
		await a.page.evaluate(() => window.__test.join('AliceName'));
		await b.page.evaluate(() => window.__test.waitRoster([{ key: 'alice', name: 'AliceName' }]));
	} finally {
		await a.ctx.close();
		await b.ctx.close();
	}
});

// 3 -- A and B both join, both see the full roster ---------------------

test('A and B both join; both see the full roster', async ({ browser }, testInfo) => {
	const baseURL = baseURLFromProject(testInfo);
	const a = await openPresence(browser, baseURL, 'alice');
	const b = await openPresence(browser, baseURL, 'bob');
	try {
		await a.page.evaluate(() => window.__test.reset());
		await b.page.evaluate(() => window.__test.waitRoster([]));
		await a.page.evaluate(() => window.__test.join('AliceName'));
		await b.page.evaluate(() => window.__test.join('BobName'));
		const expected = [
			{ key: 'alice', name: 'AliceName' },
			{ key: 'bob', name: 'BobName' }
		];
		await a.page.evaluate((e) => window.__test.waitRoster(e), expected);
		await b.page.evaluate((e) => window.__test.waitRoster(e), expected);
	} finally {
		await a.ctx.close();
		await b.ctx.close();
	}
});

// 4 -- A leaves, B sees A removed --------------------------------------

test('A leaves explicitly; B sees A removed from the roster', async ({ browser }, testInfo) => {
	const baseURL = baseURLFromProject(testInfo);
	const a = await openPresence(browser, baseURL, 'alice');
	const b = await openPresence(browser, baseURL, 'bob');
	try {
		await a.page.evaluate(() => window.__test.reset());
		await b.page.evaluate(() => window.__test.waitRoster([]));
		await a.page.evaluate(() => window.__test.join('AliceName'));
		await b.page.evaluate(() => window.__test.join('BobName'));
		const both = [
			{ key: 'alice', name: 'AliceName' },
			{ key: 'bob', name: 'BobName' }
		];
		await b.page.evaluate((e) => window.__test.waitRoster(e), both);
		await a.page.evaluate(() => window.__test.leave());
		await b.page.evaluate(() => window.__test.waitRoster([{ key: 'bob', name: 'BobName' }]));
	} finally {
		await a.ctx.close();
		await b.ctx.close();
	}
});

// 5 -- Late join: C subscribes after A and B joined; sees the full roster

test('late join: C subscribes after A and B; initial fetch sees full roster', async ({ browser }, testInfo) => {
	const baseURL = baseURLFromProject(testInfo);
	const a = await openPresence(browser, baseURL, 'alice');
	const b = await openPresence(browser, baseURL, 'bob');
	try {
		await a.page.evaluate(() => window.__test.reset());
		await b.page.evaluate(() => window.__test.waitRoster([]));
		await a.page.evaluate(() => window.__test.join('AliceName'));
		await b.page.evaluate(() => window.__test.join('BobName'));
		const both = [
			{ key: 'alice', name: 'AliceName' },
			{ key: 'bob', name: 'BobName' }
		];
		await b.page.evaluate((e) => window.__test.waitRoster(e), both);
		const c = await openPresence(browser, baseURL, 'carol');
		try {
			await c.page.evaluate((e) => window.__test.waitRoster(e), both);
		} finally {
			await c.ctx.close();
		}
	} finally {
		await a.ctx.close();
		await b.ctx.close();
	}
});

// 6 -- Re-join updates the entry's name (key is stable; merge replaces)

test('rejoin with a new name updates the entry in place (key-stable)', async ({ browser }, testInfo) => {
	const baseURL = baseURLFromProject(testInfo);
	const a = await openPresence(browser, baseURL, 'alice');
	const b = await openPresence(browser, baseURL, 'bob');
	try {
		await a.page.evaluate(() => window.__test.reset());
		await b.page.evaluate(() => window.__test.waitRoster([]));
		await a.page.evaluate(() => window.__test.join('AliceFirst'));
		await b.page.evaluate(() => window.__test.waitRoster([{ key: 'alice', name: 'AliceFirst' }]));
		await a.page.evaluate(() => window.__test.join('AliceSecond'));
		await b.page.evaluate(() => window.__test.waitRoster([{ key: 'alice', name: 'AliceSecond' }]));
	} finally {
		await a.ctx.close();
		await b.ctx.close();
	}
});
