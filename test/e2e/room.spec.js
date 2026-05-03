import { test, expect } from '@playwright/test';
import { DEV_PORT, PROD_PORT } from './ports.js';

// live.room() e2e: proves the bundled data + presence + cursors +
// scoped-actions primitive round-trips across multiple connected
// clients. Uses the same per-context cookie-driven identity pattern
// as the presence and cursor specs.
//
// Note on scenario 7 (room hooks shortcut): test/fixture/src/hooks.ws.js
// exports the top-level `message` from svelte-realtime/server, which
// handles every registered live function regardless of how it was
// declared (live, live.stream, live.room). All scenarios below
// implicitly verify the room's data + presence + cursor + action
// wiring flows end-to-end through that single message export, which
// is the same wiring `board.hooks.message` would provide. No
// dedicated test required.

async function openRoom(browser, baseURL, identity) {
	const url = new URL(baseURL);
	const ctx = await browser.newContext();
	await ctx.addCookies([{ name: 'user', value: identity, domain: url.hostname, path: '/' }]);
	const page = await ctx.newPage();
	await page.goto('/room');
	await page.waitForFunction(() => window.__test);
	await page.evaluate(() => window.__test.ready());
	return { ctx, page };
}

// Unique identity suffix per test invocation. The room implementation
// keeps an internal _presenceRef map keyed by topic + userId; on
// disconnect a 5s grace timer holds the entry. Reusing identities
// across tests can race the grace window and suppress the next
// onSubscribe `join` publish (reconnect path is silent by design).
// Suffixing keeps every test's identity pool fresh.
let _idCounter = 0;
function uid(name) {
	return name + '-' + (++_idCounter) + '-' + Date.now().toString(36);
}

function baseURLFromProject(testInfo) {
	const isProd = testInfo.project.name.endsWith('-prod');
	return 'http://localhost:' + (isProd ? PROD_PORT : DEV_PORT);
}

// Browser-side polling helpers for the presence stream's roster.
async function waitPresenceContains(page, key, timeoutMs = 5000) {
	await page.evaluate(({ k, ms }) => {
		return new Promise((resolve, reject) => {
			const start = Date.now();
			const check = () => {
				const v = window.__test.readPresence1();
				if (Array.isArray(v) && v.some((e) => e.key === k)) return resolve(v);
				if (Date.now() - start > ms) {
					return reject(new Error('waitPresenceContains timeout: ' + JSON.stringify(v)));
				}
				setTimeout(check, 50);
			};
			check();
		});
	}, { k: key, ms: timeoutMs });
}

async function waitPresenceMissing(page, key, timeoutMs = 5000) {
	await page.evaluate(({ k, ms }) => {
		return new Promise((resolve, reject) => {
			const start = Date.now();
			const check = () => {
				const v = window.__test.readPresence1();
				if (Array.isArray(v) && !v.some((e) => e.key === k)) return resolve(v);
				if (Date.now() - start > ms) {
					return reject(new Error('waitPresenceMissing timeout: ' + JSON.stringify(v)));
				}
				setTimeout(check, 50);
			};
			check();
		});
	}, { k: key, ms: timeoutMs });
}

test.beforeEach(async ({ page }) => {
	await page.goto('/room');
	await page.waitForFunction(() => window.__test);
	await page.evaluate(() => window.__test.reset());
});

// 1 -- single client: data initial fetch + presence/cursor stream shapes -

test('single client: data initial fetch is the loader result; presence and cursor streams are arrays', async ({ page }) => {
	// After reset, both data streams hold the loader's empty array.
	const cards1 = await page.evaluate(() => window.__test.readCards1());
	const cards2 = await page.evaluate(() => window.__test.readCards2());
	expect(cards1).toEqual([]);
	expect(cards2).toEqual([]);

	// Presence and cursor sub-streams initialise as arrays. The room's
	// presence config triggers an onSubscribe `join` publish on the
	// data stream; whether the page sees its own join in this single
	// test depends on subscription order and whether the platform's
	// presence plugin replays prior state (not enabled in this
	// fixture). We assert only the structural contract here.
	const presence = await page.evaluate(() => window.__test.readPresence1());
	const cursors = await page.evaluate(() => window.__test.readCursors1());
	expect(Array.isArray(presence)).toBe(true);
	expect(Array.isArray(cursors)).toBe(true);
	expect(cursors.length).toBe(0);
});

// 2 -- cross-client data: A addCard, B sees it via merge: 'crud' ---------

test('cross-client data: A addCard publishes created; B sees the new card', async ({ browser }, testInfo) => {
	const baseURL = baseURLFromProject(testInfo);
	const a = await openRoom(browser, baseURL, uid('alice'));
	const b = await openRoom(browser, baseURL, uid('bob'));
	try {
		await a.page.evaluate(() => window.__test.reset());
		await b.page.evaluate(() => window.__test.waitCards1([]));
		const card = await a.page.evaluate(() => window.__test.addCard1('Hello'));
		expect(card.title).toBe('Hello');
		await b.page.evaluate(
			(c) => window.__test.waitCards1([{ id: c.id, title: c.title }]),
			card
		);
	} finally {
		await a.ctx.close();
		await b.ctx.close();
	}
});

// 3 -- cross-client presence: B joining publishes a `join` event that
//      reaches A's presence stream.
//
// The most reliable cross-client presence assertion against the
// current adapter (no platform.presence plugin enabled in
// svelte.config.js) is one-directional: A subscribes first, lets the
// room presence settle, then B opens and B's data-stream subscribe
// fires the room's onSubscribe hook which publishes a `join` event
// to `board:r1:presence`. A is already subscribed to that topic and
// observes B in its presence roster.
//
// B does not necessarily observe A in its own roster because the
// presence stream's init falls back to `[]` without the platform
// presence plugin replaying prior joins.

test('cross-client presence: B joins after A; A presence stream picks up B', async ({ browser }, testInfo) => {
	const baseURL = baseURLFromProject(testInfo);
	const aliceId = uid('alice');
	const bobId = uid('bob');
	const a = await openRoom(browser, baseURL, aliceId);
	try {
		const b = await openRoom(browser, baseURL, bobId);
		try {
			await waitPresenceContains(a.page, bobId);
		} finally {
			await b.ctx.close();
		}
	} finally {
		await a.ctx.close();
	}
});

// 4 -- cross-client cursors: A setCursor, B sees A on the cursor stream --

test('cross-client cursors: A setCursor publishes update; B sees A cursor', async ({ browser }, testInfo) => {
	const baseURL = baseURLFromProject(testInfo);
	const aliceId = uid('alice');
	const bobId = uid('bob');
	const a = await openRoom(browser, baseURL, aliceId);
	const b = await openRoom(browser, baseURL, bobId);
	try {
		await a.page.evaluate(() => window.__test.reset());
		await b.page.evaluate(() => window.__test.waitCards1([]));
		await a.page.evaluate(() => window.__test.setCursor1(42, 84));
		await b.page.evaluate(
			(key) => window.__test.waitCursors1([{ key, x: 42, y: 84 }]),
			aliceId
		);
	} finally {
		await a.ctx.close();
		await b.ctx.close();
	}
});

// 5 -- auto-leave: B closes its context; A eventually sees B removed -----

test('auto-leave on disconnect: B closes context; A eventually sees B removed from presence', async ({ browser }, testInfo) => {
	test.setTimeout(20000);
	const baseURL = baseURLFromProject(testInfo);
	const aliceId = uid('alice');
	const bobId = uid('bob');
	const a = await openRoom(browser, baseURL, aliceId);
	const b = await openRoom(browser, baseURL, bobId);
	try {
		// Wait until A's presence reflects B before closing B, so the
		// assertion that follows observes B being removed, not B never
		// being there. We do not assert the symmetric "B sees A" case
		// because that requires platform.presence.list replay (not
		// enabled in this fixture's svelte.config.js).
		await waitPresenceContains(a.page, bobId);
		await b.ctx.close();
		// Room presence has a 5s grace window before publishing the
		// leave event; allow up to 12s to absorb that plus jitter on
		// prod builds.
		await waitPresenceMissing(a.page, bobId, 12000);
	} finally {
		await a.ctx.close();
	}
});

// 6 -- two rooms isolated: r1 addCard does not leak into r2 data stream --

test('two rooms isolated: A addCard1 does not affect B cards2 stream', async ({ browser }, testInfo) => {
	const baseURL = baseURLFromProject(testInfo);
	const a = await openRoom(browser, baseURL, uid('alice'));
	const b = await openRoom(browser, baseURL, uid('bob'));
	try {
		await a.page.evaluate(() => window.__test.reset());
		await b.page.evaluate(() => window.__test.waitCards1([]));
		await b.page.evaluate(() => window.__test.waitCards2([]));
		const card = await a.page.evaluate(() => window.__test.addCard1('Only-r1'));
		// B sees the r1 card on cards1 ...
		await b.page.evaluate(
			(c) => window.__test.waitCards1([{ id: c.id, title: c.title }]),
			card
		);
		// ... but cards2 stays empty (room topics are isolated).
		const cards2 = await b.page.evaluate(() => window.__test.readCards2());
		expect(cards2).toEqual([]);
		// Now publish to r2 and confirm cards1 does NOT pick it up.
		const card2 = await a.page.evaluate(() => window.__test.addCard2('Only-r2'));
		await b.page.evaluate(
			(c) => window.__test.waitCards2([{ id: c.id, title: c.title }]),
			card2
		);
		const cards1Now = await b.page.evaluate(() => window.__test.readCards1());
		expect(cards1Now).toEqual([{ id: card.id, title: card.title }]);
	} finally {
		await a.ctx.close();
		await b.ctx.close();
	}
});

// 7 -- removeCard publishes deleted; subscribed peer sees the card gone --

test('cross-client removeCard: A removes a card; B sees the card disappear', async ({ browser }, testInfo) => {
	const baseURL = baseURLFromProject(testInfo);
	const a = await openRoom(browser, baseURL, uid('alice'));
	const b = await openRoom(browser, baseURL, uid('bob'));
	try {
		await a.page.evaluate(() => window.__test.reset());
		await b.page.evaluate(() => window.__test.waitCards1([]));
		const c1 = await a.page.evaluate(() => window.__test.addCard1('Keep'));
		const c2 = await a.page.evaluate(() => window.__test.addCard1('Drop'));
		await b.page.evaluate(
			(args) =>
				window.__test.waitCards1([
					{ id: args[0].id, title: args[0].title },
					{ id: args[1].id, title: args[1].title }
				]),
			[c1, c2]
		);
		await a.page.evaluate((id) => window.__test.removeCard1(id), c2.id);
		await b.page.evaluate(
			(c) => window.__test.waitCards1([{ id: c.id, title: c.title }]),
			c1
		);
	} finally {
		await a.ctx.close();
		await b.ctx.close();
	}
});
