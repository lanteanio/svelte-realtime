import { test, expect } from '@playwright/test';
import { DEV_PORT, PROD_PORT } from './ports.js';

// Channels (ephemeral pub/sub) e2e: proves `live.channel(...)` round-trips
// events across multiple connected clients without database state. Each
// BrowserContext sets a distinct `user` cookie so the WS upgrade hook
// reads a different identity per page (re-using the auth fixture's
// hooks.ws.js cookie path).

async function openChannels(browser, baseURL, identity) {
	const url = new URL(baseURL);
	const ctx = await browser.newContext();
	await ctx.addCookies([{ name: 'user', value: identity, domain: url.hostname, path: '/' }]);
	const page = await ctx.newPage();
	await page.goto('/channels');
	await page.waitForFunction(() => window.__test);
	await page.evaluate(() => window.__test.ready());
	return { ctx, page };
}

function baseURLFromProject(testInfo) {
	const isProd = testInfo.project.name.endsWith('-prod');
	return 'http://localhost:' + (isProd ? PROD_PORT : DEV_PORT);
}

test.beforeEach(async ({ page }) => {
	await page.goto('/channels');
	await page.waitForFunction(() => window.__test);
	await page.evaluate(() => window.__test.reset());
});

// 1 -- static channel cross-client: A subscribes, B publishes, A receives

test('static channel cross-client: A receives event B published', async ({ browser }, testInfo) => {
	const baseURL = baseURLFromProject(testInfo);
	const a = await openChannels(browser, baseURL, 'alice');
	const b = await openChannels(browser, baseURL, 'bob');
	try {
		await a.page.evaluate(() => window.__test.reset());
		await b.page.evaluate(() => window.__test.waitLobby([]));
		await b.page.evaluate(() => window.__test.sendLobby('hello-from-bob'));
		await a.page.evaluate(() =>
			window.__test.waitLobby([{ id: 'msg-1', text: 'hello-from-bob', by: 'bob' }])
		);
	} finally {
		await a.ctx.close();
		await b.ctx.close();
	}
});

// 2 -- presence channel: A and B both publish join, both see each other

test('presence channel: A and B both join; both see each other (key-stable)', async ({ browser }, testInfo) => {
	const baseURL = baseURLFromProject(testInfo);
	const a = await openChannels(browser, baseURL, 'alice');
	const b = await openChannels(browser, baseURL, 'bob');
	try {
		await a.page.evaluate(() => window.__test.reset());
		await b.page.evaluate(() => window.__test.waitRoster([]));
		await a.page.evaluate(() => window.__test.joinRoster('AliceName'));
		await b.page.evaluate(() => window.__test.joinRoster('BobName'));
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

// 3 -- ephemeral semantics: late joiner does NOT see prior events

test('ephemeral: late joiner does not see events published before subscribe', async ({ browser }, testInfo) => {
	const baseURL = baseURLFromProject(testInfo);
	const a = await openChannels(browser, baseURL, 'alice');
	try {
		await a.page.evaluate(() => window.__test.reset());
		await a.page.evaluate(() => window.__test.sendLobby('only-alice-sees-this'));
		await a.page.evaluate(() =>
			window.__test.waitLobby([{ id: 'msg-1', text: 'only-alice-sees-this', by: 'alice' }])
		);
		const b = await openChannels(browser, baseURL, 'bob');
		try {
			// Give the subscribe round-trip + any potential replay frame time to land.
			await b.page.waitForTimeout(300);
			const seen = await b.page.evaluate(() => window.__test.readLobby());
			expect(seen).toEqual([]);
		} finally {
			await b.ctx.close();
		}
	} finally {
		await a.ctx.close();
	}
});

// 4 -- dynamic channel topic isolation: r1 publish reaches r1 stores; r2 stays empty

test('dynamic channel: r1 publish reaches r1 stores on every client; r2 stores stay empty', async ({ browser }, testInfo) => {
	const baseURL = baseURLFromProject(testInfo);
	const a = await openChannels(browser, baseURL, 'alice');
	const b = await openChannels(browser, baseURL, 'bob');
	try {
		await a.page.evaluate(() => window.__test.reset());
		await b.page.evaluate(() => window.__test.waitRoom1([]));
		await a.page.evaluate(() => window.__test.sendRoom('r1', 'r1-payload'));
		const expectedR1 = [{ id: 'msg-1', text: 'r1-payload', by: 'alice', roomId: 'r1' }];
		// Every client subscribed to r1 sees the publish.
		await a.page.evaluate((e) => window.__test.waitRoom1(e), expectedR1);
		await b.page.evaluate((e) => window.__test.waitRoom1(e), expectedR1);
		// Topic isolation: r2 stores on every client stay empty.
		await b.page.waitForTimeout(200);
		const aR2 = await a.page.evaluate(() => window.__test.readRoom2());
		const bR2 = await b.page.evaluate(() => window.__test.readRoom2());
		expect(aR2).toEqual([]);
		expect(bR2).toEqual([]);
	} finally {
		await a.ctx.close();
		await b.ctx.close();
	}
});

// 5 -- multi-publish ordering: 5 events arrive in publish order

test('multi-publish ordering: A receives all 5 events B published in order', async ({ browser }, testInfo) => {
	const baseURL = baseURLFromProject(testInfo);
	const a = await openChannels(browser, baseURL, 'alice');
	const b = await openChannels(browser, baseURL, 'bob');
	try {
		await a.page.evaluate(() => window.__test.reset());
		await b.page.evaluate(() => window.__test.waitLobby([]));
		const texts = ['t1', 't2', 't3', 't4', 't5'];
		for (const t of texts) {
			await b.page.evaluate((x) => window.__test.sendLobby(x), t);
		}
		const expected = texts.map((t, i) => ({ id: 'msg-' + (i + 1), text: t, by: 'bob' }));
		await a.page.evaluate((e) => window.__test.waitLobby(e), expected);
		// Verify arrival order on A matches publish order (multiset compare
		// already passed, so now check the raw store preserves order too).
		const seen = await a.page.evaluate(() => window.__test.readLobby());
		expect(seen.map((m) => m.text)).toEqual(texts);
	} finally {
		await a.ctx.close();
		await b.ctx.close();
	}
});

// 6 -- single-client late join: initial state is empty (no init function)

test('single client: fresh subscribe yields empty array (no replay buffer)', async ({ page }) => {
	const lobby = await page.evaluate(() => window.__test.readLobby());
	const roster = await page.evaluate(() => window.__test.readRoster());
	const r1 = await page.evaluate(() => window.__test.readRoom1());
	const r2 = await page.evaluate(() => window.__test.readRoom2());
	expect(lobby).toEqual([]);
	expect(roster).toEqual([]);
	expect(r1).toEqual([]);
	expect(r2).toEqual([]);
});
