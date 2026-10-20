import { test, expect } from '@playwright/test';
import { readContext } from './run-context.js';

// board.room(() => id) on two instances sharing a Redis: pages that only call
// room(id) join through the data stream the view holds, see each other across
// replicas, and a selection made on one instance reaches a live member on the
// other and a member who opens the board later from the shared roster.

const _ctx = readContext();

async function open(browser, port, user, path) {
	const baseURL = 'http://127.0.0.1:' + port;
	const ctx = await browser.newContext({ baseURL });
	await ctx.addCookies([{ name: 'user', value: user, domain: '127.0.0.1', path: '/' }]);
	const page = await ctx.newPage();
	await page.goto(path);
	await page.waitForFunction(() => window.__mp);
	return { ctx, page };
}

const others = (page) => page.getByTestId('others');
const selections = (page) => page.getByTestId('selections');

test('room() members on different instances see each other and a selection, live and from the roster', async ({ browser }) => {
	const id = 'x' + Date.now().toString(36);
	const a = await open(browser, _ctx.portA, 'alice', `/mp/${id}?me=alice`);
	const b = await open(browser, _ctx.portB, 'bob', `/mp/${id}?me=bob`);
	let c = null;
	try {
		await expect(others(a.page)).toHaveText('bob', { timeout: 15000 });
		await expect(others(b.page)).toHaveText('alice', { timeout: 15000 });
		await a.page.evaluate(() => window.__mp.select({ start: 3, end: 7 }));
		await expect(selections(b.page)).toHaveText('alice=3-7', { timeout: 15000 });
		c = await open(browser, _ctx.portB, 'carol', `/mp/${id}?me=carol`);
		await expect(others(c.page)).toHaveText('alice,bob', { timeout: 15000 });
		await expect(selections(c.page)).toHaveText('alice=3-7');
		await expect(others(a.page)).toHaveText('bob,carol', { timeout: 15000 });
	} finally {
		await a.ctx.close();
		await b.ctx.close();
		if (c) await c.ctx.close();
	}
});
