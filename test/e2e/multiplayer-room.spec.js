import { test, expect } from '@playwright/test';
import { DEV_PORT, PROD_PORT } from './ports.js';

// board.room(() => id) joins a live.multiplayer room, follows the id, and
// leaves with the component; board.watch(() => id) shows the room without
// entering it. Each
// BrowserContext sets a distinct `user` cookie, which the fixture's WS
// upgrade hook turns into the connection's identity. A leave is driven by a
// client-side navigation, which keeps the socket open, so only the
// component's teardown can end the membership; the departed user drops off
// after the presence grace window.

const LEAVE_TIMEOUT = 12000;

function baseURLFromProject(testInfo) {
	const isProd = testInfo.project.name.endsWith('-prod');
	return 'http://localhost:' + (isProd ? PROD_PORT : DEV_PORT);
}

// A board id no other test (or earlier run against the same server) uses,
// so a member still inside its grace window never shows up elsewhere.
let boardCounter = 0;
function freshBoard() {
	return 'b' + Date.now().toString(36) + '-' + ++boardCounter;
}

async function open(browser, baseURL, user, path) {
	const url = new URL(baseURL);
	const ctx = await browser.newContext({ baseURL });
	await ctx.addCookies([{ name: 'user', value: user, domain: url.hostname, path: '/' }]);
	const page = await ctx.newPage();
	await page.goto(path);
	await page.waitForFunction(() => window.__mp);
	return { ctx, page };
}

// Navigate without reloading the document: the same page (and socket)
// survives, which the marker proves.
async function navigateInApp(page, path) {
	await page.evaluate(() => { window.__sameDocument = true; });
	await page.evaluate((p) => window.__mp.goto(p), path);
	await page.waitForURL((u) => u.pathname + u.search === path);
	expect(await page.evaluate(() => window.__sameDocument)).toBe(true);
}

const others = (page) => page.getByTestId('others');
const members = (page) => page.getByTestId('members');
const locks = (page) => page.getByTestId('locks');

test('two pages that only call room(id) see each other', async ({ browser }, testInfo) => {
	const baseURL = baseURLFromProject(testInfo);
	const id = freshBoard();
	const a = await open(browser, baseURL, 'alice', `/mp/${id}?me=alice`);
	const b = await open(browser, baseURL, 'bob', `/mp/${id}?me=bob`);
	try {
		await expect(others(a.page)).toHaveText('bob');
		await expect(others(b.page)).toHaveText('alice');
	} finally {
		await a.ctx.close();
		await b.ctx.close();
	}
});

test('navigating away from the page leaves the room', async ({ browser }, testInfo) => {
	const baseURL = baseURLFromProject(testInfo);
	const id = freshBoard();
	const a = await open(browser, baseURL, 'alice', `/mp/${id}?me=alice`);
	const b = await open(browser, baseURL, 'bob', `/mp/${id}?me=bob`);
	try {
		await expect(others(a.page)).toHaveText('bob');
		await navigateInApp(b.page, '/');
		await expect(others(a.page)).toHaveText('', { timeout: LEAVE_TIMEOUT });
	} finally {
		await a.ctx.close();
		await b.ctx.close();
	}
});

test('moving to another board leaves the first and joins the second', async ({ browser }, testInfo) => {
	const baseURL = baseURLFromProject(testInfo);
	const first = freshBoard();
	const second = freshBoard();
	const a = await open(browser, baseURL, 'alice', `/mp/${first}?me=alice`);
	const c = await open(browser, baseURL, 'carol', `/mp/${second}?me=carol`);
	const b = await open(browser, baseURL, 'bob', `/mp/${first}?me=bob`);
	try {
		await expect(others(a.page)).toHaveText('bob');
		await navigateInApp(b.page, `/mp/${second}?me=bob`);
		await expect(others(c.page)).toHaveText('bob');
		await expect(others(b.page)).toHaveText('carol');
		await expect(others(a.page)).toHaveText('', { timeout: LEAVE_TIMEOUT });
	} finally {
		await a.ctx.close();
		await b.ctx.close();
		await c.ctx.close();
	}
});

test('a lock taken in an effect moves with the board', async ({ browser }, testInfo) => {
	const baseURL = baseURLFromProject(testInfo);
	const first = freshBoard();
	const second = freshBoard();
	const b = await open(browser, baseURL, 'bob', `/mp/${first}?me=bob`);
	const c = await open(browser, baseURL, 'carol', `/mp/${second}?me=carol`);
	// The effect takes the lock as the page mounts, while its join is in flight.
	const a = await open(browser, baseURL, 'alice', `/mp/${first}?me=alice&lock=on`);
	try {
		await expect(locks(b.page)).toHaveText('title=alice');
		await expect(members(b.page)).toHaveText('alice');

		await navigateInApp(a.page, `/mp/${second}?me=alice&lock=on`);
		// Alice is still on bob's roster for the presence grace window, so the
		// lock can only have cleared because the cleanup released it there.
		await expect(locks(b.page)).toHaveText('');
		await expect(others(b.page)).toHaveText('alice');

		// The effect took the lock on the second board as the view moved there,
		// ahead of that join, with nothing done since.
		await expect(locks(c.page)).toHaveText('title=alice');
		await expect(members(c.page)).toHaveText('alice');
		await expect(locks(b.page)).toHaveText('');
		await expect(others(b.page)).toHaveText('', { timeout: LEAVE_TIMEOUT });
	} finally {
		await a.ctx.close();
		await b.ctx.close();
		await c.ctx.close();
	}
});

// /mpfade pages sit in a keyed out:fade, so the page being left runs its
// cleanups after the fade, with the page state already on the next URL.
test('a lock is released in the board being left when a page transition delays the cleanup', async ({ browser }, testInfo) => {
	const baseURL = baseURLFromProject(testInfo);
	const first = freshBoard();
	const second = freshBoard();
	const b = await open(browser, baseURL, 'bob', `/mp/${first}?me=bob`);
	const a = await open(browser, baseURL, 'alice', `/mpfade/${first}?me=alice`);
	try {
		await expect(members(b.page)).toHaveText('alice');
		await a.page.evaluate(() => window.__mp.lock(true));
		await expect(locks(b.page)).toHaveText('title=alice');

		await navigateInApp(a.page, `/mpfade/${second}?me=alice`);
		// Alice is still on bob's roster for the presence grace window, so the
		// lock can only have cleared because the cleanup released it there.
		await expect(locks(b.page)).toHaveText('');
		await expect(others(b.page)).toHaveText('alice');
		await expect(others(b.page)).toHaveText('', { timeout: LEAVE_TIMEOUT });
	} finally {
		await a.ctx.close();
		await b.ctx.close();
	}
});

// /mplayout holds the room in the layout, so it has moved to the next board
// before the page that took the lock runs its cleanup.
test('a lock taken through a layout\'s room is released in the board being left after the page fades', async ({ browser }, testInfo) => {
	const baseURL = baseURLFromProject(testInfo);
	const first = freshBoard();
	const second = freshBoard();
	const b = await open(browser, baseURL, 'bob', `/mp/${first}?me=bob`);
	const a = await open(browser, baseURL, 'alice', `/mplayout/${first}?me=alice`);
	try {
		await expect(members(b.page)).toHaveText('alice');
		await a.page.evaluate(() => window.__mp.lock(true));
		await expect(locks(b.page)).toHaveText('title=alice');

		await navigateInApp(a.page, `/mplayout/${second}?me=alice`);
		await expect(locks(b.page)).toHaveText('');
		await expect(others(b.page)).toHaveText('alice');
		await expect(others(b.page)).toHaveText('', { timeout: LEAVE_TIMEOUT });
	} finally {
		await a.ctx.close();
		await b.ctx.close();
	}
});

test('a room built in a cleanup after a page transition does not join', async ({ browser }, testInfo) => {
	const baseURL = baseURLFromProject(testInfo);
	const id = freshBoard();
	const b = await open(browser, baseURL, 'bob', `/mp/${id}?me=bob`);
	const a = await open(browser, baseURL, 'alice', `/mpfade/${id}?me=alice`);
	try {
		await expect(members(b.page)).toHaveText('alice');
		await navigateInApp(a.page, '/');
		await expect(others(b.page)).toHaveText('', { timeout: LEAVE_TIMEOUT });
	} finally {
		await a.ctx.close();
		await b.ctx.close();
	}
});

test('a watch(id) page sees the room and is on nobody\'s roster', async ({ browser }, testInfo) => {
	const baseURL = baseURLFromProject(testInfo);
	const id = freshBoard();
	const a = await open(browser, baseURL, 'alice', `/mp/${id}?me=alice`);
	const w = await open(browser, baseURL, 'walt', `/mp/${id}?me=walt&mode=watch`);
	try {
		await expect(others(w.page)).toHaveText('alice');
		// walt's subscribes completed before bob opened, so had watching joined
		// him, alice would list him beside bob.
		const b = await open(browser, baseURL, 'bob', `/mp/${id}?me=bob`);
		try {
			await expect(others(a.page)).toHaveText('bob');
			await expect(others(b.page)).toHaveText('alice');
			await expect(others(w.page)).toHaveText('alice,bob');
		} finally {
			await b.ctx.close();
		}
	} finally {
		await a.ctx.close();
		await w.ctx.close();
	}
});
