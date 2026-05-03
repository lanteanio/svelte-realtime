import { test, expect } from '@playwright/test';

// Test driver: every scenario runs through window.__test, exposed by the
// fixture page on mount. Returns native Promises so page.evaluate awaits
// the full client-side flow (RPC + queue settle + display refresh) before
// the test reads the next state. No expect.poll on intermediate state.

test.beforeEach(async ({ page }) => {
	await page.goto('/qr');
	await page.waitForFunction(() => window.__test);
	await page.evaluate(() => window.__test.reset());
});

async function todos(page) {
	return page.evaluate(() => window.__test.todos());
}

async function expectTodos(page, expected) {
	const got = await todos(page);
	got.sort((a, b) => String(a.id).localeCompare(String(b.id)));
	const norm = expected.slice().sort((a, b) => String(a.id).localeCompare(String(b.id)));
	expect(got).toEqual(norm);
}

// 1 -- single mutate happy path (no server publish; graduate-on-success) ----

test('single mutate succeeds: optimistic stays, drains to server state', async ({ page }) => {
	const r = await page.evaluate(() => window.__test.mutateOk({ id: 'a', name: 'A' }));
	expect(r).toEqual({ id: 'a', server: true, name: 'A' });
	await expectTodos(page, [{ id: 'a', name: 'A' }]);
});

// 2 -- single mutate failure: optimistic visible during in-flight, then rollback

test('single mutate fails: rolls back', async ({ page }) => {
	await page.evaluate(() => window.__test.startBlocked({ token: 'fb1', kind: 'create', id: 'b', name: 'B' }));
	await page.evaluate(() => window.__test.waitTodos([{ id: 'b', name: 'B' }]));

	const settled = await page.evaluate(() => window.__test.release({ token: 'fb1', success: false }));
	expect(settled).toEqual({ ok: false, code: 'TEST_FAIL', message: 'released as fail' });
	await expectTodos(page, []);
});

// 3 -- concurrent A+B both fail: no phantoms ------------------------------

test('concurrent A+B both fail leaves no phantom traces', async ({ page }) => {
	await page.evaluate(() => window.__test.startBlocked({ token: 'a3', kind: 'create', id: 'a', name: 'A' }));
	await page.evaluate(() => window.__test.startBlocked({ token: 'b3', kind: 'create', id: 'b', name: 'B' }));
	await page.evaluate(() => window.__test.waitTodos([{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }]));

	await page.evaluate(() => window.__test.release({ token: 'a3', success: false }));
	await expectTodos(page, [{ id: 'b', name: 'B' }]);

	await page.evaluate(() => window.__test.release({ token: 'b3', success: false }));
	await expectTodos(page, []);
});

// 4 -- concurrent A succeeds, B fails: only A visible ----------------------

test('concurrent A succeeds, B fails leaves only A visible', async ({ page }) => {
	await page.evaluate(() => window.__test.startBlocked({ token: 'a4', kind: 'create', id: 'a', name: 'A' }));
	await page.evaluate(() => window.__test.startBlocked({ token: 'b4', kind: 'create', id: 'b', name: 'B' }));
	await page.evaluate(() => window.__test.waitTodos([{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }]));

	const a = await page.evaluate(() => window.__test.release({ token: 'a4', success: true }));
	expect(a).toEqual({ ok: true, v: 'released' });

	const b = await page.evaluate(() => window.__test.release({ token: 'b4', success: false }));
	expect(b.ok).toBe(false);
	await expectTodos(page, [{ id: 'a', name: 'A' }]);
});

// 5 -- concurrent A fails, B succeeds: only B visible ----------------------

test('concurrent A fails, B succeeds leaves only B visible', async ({ page }) => {
	await page.evaluate(() => window.__test.startBlocked({ token: 'a5', kind: 'create', id: 'a', name: 'A' }));
	await page.evaluate(() => window.__test.startBlocked({ token: 'b5', kind: 'create', id: 'b', name: 'B' }));

	await page.evaluate(() => window.__test.release({ token: 'a5', success: false }));
	await expectTodos(page, [{ id: 'b', name: 'B' }]);

	await page.evaluate(() => window.__test.release({ token: 'b5', success: true }));
	await expectTodos(page, [{ id: 'b', name: 'B' }]);
});

// 6 -- server confirm with matching key during in-flight absorbs -----------

test('server confirm with matching key during in-flight absorbs (no flicker on settle)', async ({ page }) => {
	await page.evaluate(() => window.__test.startBlocked({ token: 'a6', kind: 'create', id: 'x', name: 'Pending' }));
	await page.evaluate(() => window.__test.waitTodos([{ id: 'x', name: 'Pending' }]));

	await page.evaluate(() => window.__test.publish({ event: 'created', id: 'x', name: 'Confirmed' }));
	await page.evaluate(() => window.__test.waitTodos([{ id: 'x', name: 'Confirmed' }]));

	const r = await page.evaluate(() => window.__test.release({ token: 'a6', success: true }));
	expect(r.ok).toBe(true);
	await expectTodos(page, [{ id: 'x', name: 'Confirmed' }]);
});

// 7 -- server unrelated event during in-flight: both visible ---------------

test('server event for unrelated key during in-flight: both visible', async ({ page }) => {
	await page.evaluate(() => window.__test.startBlocked({ token: 'a7', kind: 'create', id: 'opt', name: 'Opt' }));
	await page.evaluate(() => window.__test.waitTodos([{ id: 'opt', name: 'Opt' }]));

	await page.evaluate(() => window.__test.publish({ event: 'created', id: 'srv', name: 'Srv' }));
	await page.evaluate(() => window.__test.waitTodos([{ id: 'opt', name: 'Opt' }, { id: 'srv', name: 'Srv' }]));

	await page.evaluate(() => window.__test.release({ token: 'a7', success: true }));
	await expectTodos(page, [{ id: 'opt', name: 'Opt' }, { id: 'srv', name: 'Srv' }]);
});

// 8 -- free-form mutate concurrent fail: no phantom ------------------------

test('free-form mutate concurrent fail: no phantom changes', async ({ page }) => {
	await page.evaluate(() => window.__test.startBlocked({ token: 'fa', kind: 'ff', id: 'a', name: 'A' }));
	await page.evaluate(() => window.__test.startBlocked({ token: 'fb', kind: 'ff', id: 'b', name: 'B' }));
	await page.evaluate(() => window.__test.waitTodos([{ id: 'a', name: 'ff:A' }, { id: 'b', name: 'ff:B' }]));

	await page.evaluate(() => window.__test.release({ token: 'fa', success: false }));
	await expectTodos(page, [{ id: 'b', name: 'ff:B' }]);

	await page.evaluate(() => window.__test.release({ token: 'fb', success: false }));
	await expectTodos(page, []);
});

// 9 -- three concurrent mutates with mixed outcomes ------------------------

test('three concurrent mutates with mixed outcomes interleave correctly', async ({ page }) => {
	await page.evaluate(() => window.__test.startBlocked({ token: 'A', kind: 'create', id: '1', name: 'one' }));
	await page.evaluate(() => window.__test.startBlocked({ token: 'B', kind: 'create', id: '2', name: 'two' }));
	await page.evaluate(() => window.__test.startBlocked({ token: 'C', kind: 'create', id: '3', name: 'three' }));
	await page.evaluate(() => window.__test.waitTodos([
		{ id: '1', name: 'one' }, { id: '2', name: 'two' }, { id: '3', name: 'three' }
	]));

	await page.evaluate(() => window.__test.release({ token: 'B', success: false }));
	await expectTodos(page, [{ id: '1', name: 'one' }, { id: '3', name: 'three' }]);

	await page.evaluate(() => window.__test.release({ token: 'A', success: true }));
	await expectTodos(page, [{ id: '1', name: 'one' }, { id: '3', name: 'three' }]);

	await page.evaluate(() => window.__test.release({ token: 'C', success: true }));
	await expectTodos(page, [{ id: '1', name: 'one' }, { id: '3', name: 'three' }]);
});

// 10 -- mutate then drain then post-drain server event applies via hot path

test('mutate -> drain -> post-drain server event applies via hot path', async ({ page }) => {
	const r = await page.evaluate(() => window.__test.mutateOk({ id: 'first', name: 'first' }));
	expect(r.id).toBe('first');
	await expectTodos(page, [{ id: 'first', name: 'first' }]);

	await page.evaluate(() => window.__test.publish({ event: 'created', id: 'after', name: 'after' }));
	await page.evaluate(() => window.__test.waitTodos([
		{ id: 'first', name: 'first' }, { id: 'after', name: 'after' }
	]));
});
