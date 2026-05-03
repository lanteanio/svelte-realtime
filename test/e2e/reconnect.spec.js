import { test, expect } from '@playwright/test';

// Reconnect scenarios: force the WS to drop mid-flight and prove the
// realtime layer handles it correctly. Pending RPCs reject with
// DISCONNECTED, mutates roll back, and the auto-reconnect on the next
// RPC pulls fresh state from the server.
//
// We force the drop server-side via `__test.killSelf()` rather than
// Playwright's `page.context().setOffline(true)` because setOffline
// does not consistently close already-open WSs across browser
// versions -- the WS stays open from the client's perspective even
// though new requests are blocked. The killSelf RPC schedules
// `ws.close()` on the calling connection a few ms after returning,
// giving us a deterministic mid-flight drop.

async function openQrPage(browser) {
	const ctx = await browser.newContext();
	const page = await ctx.newPage();
	await page.goto('/qr');
	await page.waitForFunction(() => window.__test);
	await page.evaluate(() => window.__test.ready());
	return { ctx, page };
}

async function expectTodos(page, expected) {
	const got = await page.evaluate(() => window.__test.todos());
	got.sort((a, b) => String(a.id).localeCompare(String(b.id)));
	const norm = expected.slice().sort((a, b) => String(a.id).localeCompare(String(b.id)));
	expect(got).toEqual(norm);
}

// 1 -- Mid-mutate disconnect: blocked mutate rejects, optimistic rolls back

test('mid-mutate disconnect: blocked asyncOp rejects with DISCONNECTED, optimistic rolls back', async ({ browser }) => {
	const a = await openQrPage(browser);
	try {
		await a.page.evaluate(() => window.__test.reset());

		// Start a blocked mutate so the asyncOp is in flight when we go
		// offline. The optimistic 'created' for {id:'a'} is visible; the
		// asyncOp is the server's `block({token})` which never resolves
		// until release(). Going offline kills the WS, the in-flight
		// block() RPC rejects with DISCONNECTED, mutate's settle(false)
		// runs, the optimistic queue entry is removed and currentValue
		// rolls back to []. After this test the server still holds the
		// orphan deferred in `_blocked`; the next test's reset clears it.
		await a.page.evaluate(() => window.__test.startBlocked({
			token: 'rc1', kind: 'create', id: 'a', name: 'A'
		}));
		await a.page.evaluate(() => window.__test.waitTodos([{ id: 'a', name: 'A' }]));

		await a.page.evaluate(() => window.__test.killSelf());

		// Wait for the mutate to settle by polling todos -- replay drains
		// the queue entry on settle(false), so the displayed value
		// becomes [] once the in-flight RPC rejects.
		await a.page.evaluate(() => window.__test.waitTodos([]));
	} finally {
		await a.ctx.close();
	}
});

// 2 -- Three concurrent in-flight mutates all roll back on disconnect ------

test('three concurrent mutates all roll back when WS drops', async ({ browser }) => {
	const a = await openQrPage(browser);
	try {
		await a.page.evaluate(() => window.__test.reset());

		await a.page.evaluate(() => window.__test.startBlocked({ token: 'A', kind: 'create', id: '1', name: 'one' }));
		await a.page.evaluate(() => window.__test.startBlocked({ token: 'B', kind: 'create', id: '2', name: 'two' }));
		await a.page.evaluate(() => window.__test.startBlocked({ token: 'C', kind: 'create', id: '3', name: 'three' }));
		await a.page.evaluate(() => window.__test.waitTodos([
			{ id: '1', name: 'one' }, { id: '2', name: 'two' }, { id: '3', name: 'three' }
		]));

		await a.page.evaluate(() => window.__test.killSelf());
		await a.page.evaluate(() => window.__test.waitTodos([]));
	} finally {
		await a.ctx.close();
	}
});

// 3 -- Disconnect + reconnect: A reconnects after offline, catches up via
//      replay on the server's missed events. While A is offline, B publishes.

test('disconnect + reconnect: A catches up on B publishes via replay-on-reconnect', async ({ browser }) => {
	const a = await openQrPage(browser);
	const b = await openQrPage(browser);
	try {
		await a.page.evaluate(() => window.__test.reset());
		await b.page.evaluate(() => window.__test.waitTodos([]));

		// Establish a baseline shared item.
		await a.page.evaluate(() => window.__test.publish({ event: 'created', id: 'baseline', name: 'B0' }));
		await a.page.evaluate(() => window.__test.waitTodos([{ id: 'baseline', name: 'B0' }]));
		await b.page.evaluate(() => window.__test.waitTodos([{ id: 'baseline', name: 'B0' }]));

		// A goes offline. B keeps publishing. Server _state grows with B's
		// publishes; A's WS is dead so A receives nothing.
		await a.ctx.setOffline(true);

		await b.page.evaluate(() => window.__test.publish({ event: 'created', id: 'while-off-1', name: 'WO1' }));
		await b.page.evaluate(() => window.__test.publish({ event: 'created', id: 'while-off-2', name: 'WO2' }));
		await b.page.evaluate(() => window.__test.waitTodos([
			{ id: 'baseline', name: 'B0' },
			{ id: 'while-off-1', name: 'WO1' },
			{ id: 'while-off-2', name: 'WO2' }
		]));

		// A still shows the pre-disconnect state (no events delivered).
		await expectTodos(a.page, [{ id: 'baseline', name: 'B0' }]);

		// Bring A back online. The realtime client auto-reconnects and
		// re-fetches the topic; the initial fetch returns the current
		// server _state, which now includes B's events.
		await a.ctx.setOffline(false);
		await a.page.evaluate(() => window.__test.waitTodos([
			{ id: 'baseline', name: 'B0' },
			{ id: 'while-off-1', name: 'WO1' },
			{ id: 'while-off-2', name: 'WO2' }
		]));
	} finally {
		await a.ctx.setOffline(false);
		await a.ctx.close();
		await b.ctx.close();
	}
});

// 4 -- Mid-mutate disconnect + reconnect: in-flight mutate rolls back on
//      disconnect; AFTER reconnect, a fresh mutate works against the
//      reconnected WS.

test('reconnect after mid-mutate disconnect: subsequent mutate works on the reconnected WS', async ({ browser }) => {
	const a = await openQrPage(browser);
	try {
		await a.page.evaluate(() => window.__test.reset());

		// In-flight mutate, kill WS, optimistic rolls back.
		await a.page.evaluate(() => window.__test.startBlocked({
			token: 'first', kind: 'create', id: 'gone', name: 'gone'
		}));
		await a.page.evaluate(() => window.__test.waitTodos([{ id: 'gone', name: 'gone' }]));

		await a.page.evaluate(() => window.__test.killSelf());
		await a.page.evaluate(() => window.__test.waitTodos([]));

		// After the WS closes, the realtime client auto-reconnects on the
		// next outgoing RPC. `mutateOk` runs the asyncOp, which triggers
		// reconnect if needed, then settles normally.
		await a.page.evaluate(() => window.__test.ready());
		const r = await a.page.evaluate(() => window.__test.mutateOk({ id: 'after', name: 'After' }));
		expect(r.id).toBe('after');
		await a.page.evaluate(() => window.__test.waitTodos([{ id: 'after', name: 'After' }]));
	} finally {
		await a.ctx.close();
	}
});
