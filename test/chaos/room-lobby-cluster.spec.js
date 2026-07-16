import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Cluster coordination for an enumerable owner room (the demo-lobbies shape):
// two members join one table from DIFFERENT instances on a shared Redis.
//
// Guards the three cross-replica guarantees that broke together (each member
// saw everyone except themselves; the registry count never decremented):
// 1. presence self-delivery - the joiner's own entry rides its :presence
//    subscribe response (the barrier in room-owner.js), so the FIRST member
//    sees itself before anyone else joins;
// 2. cross-replica roster convergence - both members see both entries, on
//    both instances (shared-roster snapshot + relayed live joins);
// 3. registry release on a live-socket leave - dropping the sub-streams with
//    the WS still open decrements the cluster-wide rooms() count everywhere
//    and, after the presence grace window, removes the member from the
//    remaining viewer's roster.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const _ctx = JSON.parse(readFileSync(path.join(__dirname, '.chaos-ctx.json'), 'utf-8'));

async function openLobby(browser, port, identity) {
	const baseURL = 'http://127.0.0.1:' + port;
	const ctx = await browser.newContext({ baseURL });
	await ctx.addCookies([{ name: 'user', value: identity, domain: '127.0.0.1', path: '/' }]);
	const page = await ctx.newPage();
	await page.goto('/lobby');
	await page.waitForFunction(() => window.__test);
	await page.evaluate(() => window.__test.ready());
	return { ctx, page };
}

test('enumerable owner room: presence self-delivery, cross-replica roster, and registry decrement on live-socket leave', async ({ browser }) => {
	const a = await openLobby(browser, _ctx.portA, 'alice');
	const b = await openLobby(browser, _ctx.portB, 'bob');
	const table = 't' + Date.now();
	// RoomsList keys its entries by the room's identifying arg, not the topic.
	const roomKey = table;
	try {
		// Alice joins on instance A: she must see HERSELF immediately (the
		// pre-fix bug left the first joiner's own entry out of both the
		// snapshot and the live event), and the registry opens at count 1.
		await a.page.evaluate((id) => window.__test.join(id), table);
		await a.page.evaluate((args) => window.__test.waitRoster(args.roster), { roster: ['alice'] });
		await a.page.evaluate((args) => window.__test.waitRoomCount(args.key, args.count), { key: roomKey, count: 1 });
		expect(await a.page.evaluate(() => window.__test.readOwner())).toMatchObject({ key: 'alice' });

		// Bob joins the SAME table on instance B: both rosters converge to
		// both members, the registry reads 2 on both instances, and bob sees
		// alice as the owner.
		await b.page.evaluate((id) => window.__test.join(id), table);
		await b.page.evaluate((args) => window.__test.waitRoster(args.roster), { roster: ['alice', 'bob'] });
		await a.page.evaluate((args) => window.__test.waitRoster(args.roster), { roster: ['alice', 'bob'] });
		await a.page.evaluate((args) => window.__test.waitRoomCount(args.key, args.count), { key: roomKey, count: 2 });
		await b.page.evaluate((args) => window.__test.waitRoomCount(args.key, args.count), { key: roomKey, count: 2 });
		expect(await b.page.evaluate(() => window.__test.readOwner())).toMatchObject({ key: 'alice' });

		// Bob leaves with his socket still open. The registry decrement is
		// immediate (the unsubscribe drain releases the shared roster and the
		// delta relays); the presence leave lands after the 5s grace window.
		await b.page.evaluate(() => window.__test.leave());
		await a.page.evaluate((args) => window.__test.waitRoomCount(args.key, args.count), { key: roomKey, count: 1 });
		await a.page.evaluate((args) => window.__test.waitRoster(args.roster, 15000), { roster: ['alice'] });
	} finally {
		await a.ctx.close();
		await b.ctx.close();
	}
});
