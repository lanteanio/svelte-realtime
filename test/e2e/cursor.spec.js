import { test, expect } from '@playwright/test';
import { DEV_PORT, PROD_PORT } from './ports.js';

// Cursor merge-strategy e2e: proves `merge: 'cursor'` update/remove
// events round-trip across multiple connected clients. Uses the same
// per-context cookie-driven identity pattern as the presence spec.

async function openCursor(browser, baseURL, identity) {
	const url = new URL(baseURL);
	const ctx = await browser.newContext();
	await ctx.addCookies([{ name: 'user', value: identity, domain: url.hostname, path: '/' }]);
	const page = await ctx.newPage();
	await page.goto('/cursor');
	await page.waitForFunction(() => window.__test);
	await page.evaluate(() => window.__test.ready());
	return { ctx, page };
}

function baseURLFromProject(testInfo) {
	const isProd = testInfo.project.name.endsWith('-prod');
	return 'http://localhost:' + (isProd ? PROD_PORT : DEV_PORT);
}

test.beforeEach(async ({ page }) => {
	await page.goto('/cursor');
	await page.waitForFunction(() => window.__test);
	await page.evaluate(() => window.__test.reset());
});

// 1 -- single client move + remove ----------------------------------------

test('single client: move then remove updates the cursor list', async ({ page }) => {
	await page.evaluate(() => window.__test.move({ x: 10, y: 20, color: '#ff0000' }));
	await page.evaluate(() =>
		window.__test.waitCursors([{ key: 'e2e-user', x: 10, y: 20, color: '#ff0000' }])
	);
	await page.evaluate(() => window.__test.remove());
	await page.evaluate(() => window.__test.waitCursors([]));
});

// 2 -- A moves; B sees A's cursor (cross-client visibility) ---------------

test('cross-client: A moves, B sees A cursor at the same position', async ({ browser }, testInfo) => {
	const baseURL = baseURLFromProject(testInfo);
	const a = await openCursor(browser, baseURL, 'alice');
	const b = await openCursor(browser, baseURL, 'bob');
	try {
		await a.page.evaluate(() => window.__test.reset());
		await b.page.evaluate(() => window.__test.waitCursors([]));
		await a.page.evaluate(() => window.__test.move({ x: 5, y: 7, color: '#0000ff' }));
		await b.page.evaluate(() =>
			window.__test.waitCursors([{ key: 'alice', x: 5, y: 7, color: '#0000ff' }])
		);
	} finally {
		await a.ctx.close();
		await b.ctx.close();
	}
});

// 3 -- A and B both move; both see each other ---------------------------

test('A and B both move; each side sees both cursors', async ({ browser }, testInfo) => {
	const baseURL = baseURLFromProject(testInfo);
	const a = await openCursor(browser, baseURL, 'alice');
	const b = await openCursor(browser, baseURL, 'bob');
	try {
		await a.page.evaluate(() => window.__test.reset());
		await b.page.evaluate(() => window.__test.waitCursors([]));
		await a.page.evaluate(() => window.__test.move({ x: 1, y: 1, color: '#aa0000' }));
		await b.page.evaluate(() => window.__test.move({ x: 2, y: 3, color: '#00aa00' }));
		const expected = [
			{ key: 'alice', x: 1, y: 1, color: '#aa0000' },
			{ key: 'bob', x: 2, y: 3, color: '#00aa00' }
		];
		await a.page.evaluate((e) => window.__test.waitCursors(e), expected);
		await b.page.evaluate((e) => window.__test.waitCursors(e), expected);
	} finally {
		await a.ctx.close();
		await b.ctx.close();
	}
});

// 4 -- repeated move from the same key updates in place -----------------

test('repeated move from A updates A cursor in place (key-stable)', async ({ browser }, testInfo) => {
	const baseURL = baseURLFromProject(testInfo);
	const a = await openCursor(browser, baseURL, 'alice');
	const b = await openCursor(browser, baseURL, 'bob');
	try {
		await a.page.evaluate(() => window.__test.reset());
		await b.page.evaluate(() => window.__test.waitCursors([]));
		await a.page.evaluate(() => window.__test.move({ x: 1, y: 1, color: '#000' }));
		await b.page.evaluate(() =>
			window.__test.waitCursors([{ key: 'alice', x: 1, y: 1, color: '#000' }])
		);
		await a.page.evaluate(() => window.__test.move({ x: 99, y: 99, color: '#000' }));
		await b.page.evaluate(() =>
			window.__test.waitCursors([{ key: 'alice', x: 99, y: 99, color: '#000' }])
		);
	} finally {
		await a.ctx.close();
		await b.ctx.close();
	}
});

// 5 -- A removes; B sees A's cursor disappear --------------------------

test('A removes; B sees A removed from the cursor list', async ({ browser }, testInfo) => {
	const baseURL = baseURLFromProject(testInfo);
	const a = await openCursor(browser, baseURL, 'alice');
	const b = await openCursor(browser, baseURL, 'bob');
	try {
		await a.page.evaluate(() => window.__test.reset());
		await b.page.evaluate(() => window.__test.waitCursors([]));
		await a.page.evaluate(() => window.__test.move({ x: 4, y: 4, color: '#fff' }));
		await b.page.evaluate(() => window.__test.move({ x: 5, y: 5, color: '#000' }));
		const both = [
			{ key: 'alice', x: 4, y: 4, color: '#fff' },
			{ key: 'bob', x: 5, y: 5, color: '#000' }
		];
		await b.page.evaluate((e) => window.__test.waitCursors(e), both);
		await a.page.evaluate(() => window.__test.remove());
		await b.page.evaluate(() =>
			window.__test.waitCursors([{ key: 'bob', x: 5, y: 5, color: '#000' }])
		);
	} finally {
		await a.ctx.close();
		await b.ctx.close();
	}
});

// 6 -- late join: C subscribes after A and B; sees both cursors --------

test('late join: C subscribes after A and B; initial fetch sees both cursors', async ({ browser }, testInfo) => {
	const baseURL = baseURLFromProject(testInfo);
	const a = await openCursor(browser, baseURL, 'alice');
	const b = await openCursor(browser, baseURL, 'bob');
	try {
		await a.page.evaluate(() => window.__test.reset());
		await b.page.evaluate(() => window.__test.waitCursors([]));
		await a.page.evaluate(() => window.__test.move({ x: 11, y: 22, color: '#aaa' }));
		await b.page.evaluate(() => window.__test.move({ x: 33, y: 44, color: '#bbb' }));
		const expected = [
			{ key: 'alice', x: 11, y: 22, color: '#aaa' },
			{ key: 'bob', x: 33, y: 44, color: '#bbb' }
		];
		await b.page.evaluate((e) => window.__test.waitCursors(e), expected);
		const c = await openCursor(browser, baseURL, 'carol');
		try {
			await c.page.evaluate((e) => window.__test.waitCursors(e), expected);
		} finally {
			await c.ctx.close();
		}
	} finally {
		await a.ctx.close();
		await b.ctx.close();
	}
});
