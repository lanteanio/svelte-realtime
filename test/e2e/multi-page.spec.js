import { test, expect } from '@playwright/test';

// Multi-page e2e: every test opens 2+ independent BrowserContexts so each
// "client" gets its own WS connection. Proves cross-connection pubsub,
// cross-client optimistic absorb, late-join replay from server _state,
// and cross-client lock contention. The single-page specs cover one
// client's view of the system; these specs cover the system AS A
// COLLABORATIVE SURFACE.

async function openQrPage(browser) {
	const ctx = await browser.newContext();
	const page = await ctx.newPage();
	await page.goto('/qr');
	await page.waitForFunction(() => window.__test);
	// Wait for WS handshake AND initial fetch before the test starts
	// driving RPCs. Without this, multiple-context tests can race the
	// cold-start window (initial fetch returns `undefined` for a few ms).
	await page.evaluate(() => window.__test.ready());
	return { ctx, page };
}

async function openLockPage(browser) {
	const ctx = await browser.newContext();
	const page = await ctx.newPage();
	await page.goto('/lock');
	await page.waitForFunction(() => window.__test);
	await page.evaluate(() => window.__test.ready());
	return { ctx, page };
}

async function todos(page) {
	return page.evaluate(() => window.__test.todos());
}

async function expectTodos(page, expected) {
	const got = await todos(page);
	got.sort((a, b) => String(a.id).localeCompare(String(b.id)));
	const norm = expected.slice().sort((a, b) => String(a.id).localeCompare(String(b.id)));
	expect(got).toEqual(norm);
}

// 1 -- Page A publishes via external RPC, Page B sees it -------------------

test('cross-client created: A publishes, B sees', async ({ browser }) => {
	const a = await openQrPage(browser);
	const b = await openQrPage(browser);
	try {
		await a.page.evaluate(() => window.__test.reset());
		await b.page.evaluate(() => window.__test.waitTodos([]));

		await a.page.evaluate(() => window.__test.publish({ event: 'created', id: 'shared', name: 'fromA' }));
		await b.page.evaluate(() => window.__test.waitTodos([{ id: 'shared', name: 'fromA' }]));
		await expectTodos(a.page, [{ id: 'shared', name: 'fromA' }]);
	} finally {
		await a.ctx.close();
		await b.ctx.close();
	}
});

// 2 -- Cross-client updated: A updates an existing key, B sees the change --

test('cross-client updated: A updates, B sees the new value', async ({ browser }) => {
	const a = await openQrPage(browser);
	const b = await openQrPage(browser);
	try {
		await a.page.evaluate(() => window.__test.reset());
		await b.page.evaluate(() => window.__test.waitTodos([]));

		await a.page.evaluate(() => window.__test.publish({ event: 'created', id: 'k', name: 'v1' }));
		await b.page.evaluate(() => window.__test.waitTodos([{ id: 'k', name: 'v1' }]));

		await a.page.evaluate(() => window.__test.publish({ event: 'updated', id: 'k', name: 'v2' }));
		await b.page.evaluate(() => window.__test.waitTodos([{ id: 'k', name: 'v2' }]));
		await expectTodos(a.page, [{ id: 'k', name: 'v2' }]);
	} finally {
		await a.ctx.close();
		await b.ctx.close();
	}
});

// 3 -- Cross-client deleted: A deletes, B sees the removal -----------------

test('cross-client deleted: A removes, B sees the removal', async ({ browser }) => {
	const a = await openQrPage(browser);
	const b = await openQrPage(browser);
	try {
		await a.page.evaluate(() => window.__test.reset());
		await b.page.evaluate(() => window.__test.waitTodos([]));

		await a.page.evaluate(() => window.__test.publish({ event: 'created', id: 'doomed', name: 'D' }));
		await b.page.evaluate(() => window.__test.waitTodos([{ id: 'doomed', name: 'D' }]));

		await a.page.evaluate(() => window.__test.publish({ event: 'deleted', id: 'doomed', name: '_' }));
		await b.page.evaluate(() => window.__test.waitTodos([]));
		await expectTodos(a.page, []);
	} finally {
		await a.ctx.close();
		await b.ctx.close();
	}
});

// 4 -- Local mutate that publishes server-side fans out to other clients ---

test('mutateOkPublish: A local mutate publishes server-side; B sees', async ({ browser }) => {
	const a = await openQrPage(browser);
	const b = await openQrPage(browser);
	try {
		await a.page.evaluate(() => window.__test.reset());
		await b.page.evaluate(() => window.__test.waitTodos([]));

		// okWithPublish writes to server _state AND ctx.publish('created'). The
		// optimistic data for A is { id, name }; the server publishes the
		// "Confirmed:" prefix. A's mutate promise resolves on the RPC
		// response; the publish frame may land via RAF batching shortly
		// after (the in-place 'created' overwrite turns 'first' into
		// 'Confirmed:first'). waitTodos polls until convergence.
		await a.page.evaluate(() => window.__test.mutateOkPublish({ id: 'opt', name: 'first' }));
		await a.page.evaluate(() => window.__test.waitTodos([{ id: 'opt', name: 'Confirmed:first' }]));
		await b.page.evaluate(() => window.__test.waitTodos([{ id: 'opt', name: 'Confirmed:first' }]));
	} finally {
		await a.ctx.close();
		await b.ctx.close();
	}
});

// 5 -- Local-only mutate (no publish) does NOT cross to other clients ------

test('mutateOk: A local mutate without publish does NOT reach B', async ({ browser }) => {
	const a = await openQrPage(browser);
	const b = await openQrPage(browser);
	try {
		await a.page.evaluate(() => window.__test.reset());
		await b.page.evaluate(() => window.__test.waitTodos([]));

		// `ok` server-side returns a value but does NOT publish. A's optimistic
		// graduates locally, but B never sees it because no server event was
		// emitted. This is the documented contract: optimistic state is
		// per-client until the server publishes.
		await a.page.evaluate(() => window.__test.mutateOk({ id: 'local', name: 'A-only' }));
		await expectTodos(a.page, [{ id: 'local', name: 'A-only' }]);

		// Give a generous window for any cross-client leak; B should still be empty.
		await b.page.waitForTimeout(200);
		await expectTodos(b.page, []);
	} finally {
		await a.ctx.close();
		await b.ctx.close();
	}
});

// 6 -- Three clients all see the same publish ------------------------------

test('three clients all see the same publish', async ({ browser }) => {
	const a = await openQrPage(browser);
	const b = await openQrPage(browser);
	const c = await openQrPage(browser);
	try {
		await a.page.evaluate(() => window.__test.reset());
		await b.page.evaluate(() => window.__test.waitTodos([]));
		await c.page.evaluate(() => window.__test.waitTodos([]));

		await a.page.evaluate(() => window.__test.publish({ event: 'created', id: 'multi', name: 'M' }));
		await b.page.evaluate(() => window.__test.waitTodos([{ id: 'multi', name: 'M' }]));
		await c.page.evaluate(() => window.__test.waitTodos([{ id: 'multi', name: 'M' }]));
	} finally {
		await a.ctx.close();
		await b.ctx.close();
		await c.ctx.close();
	}
});

// 7 -- Cross-client absorb: A is in queue mode for id=x with optimistic
//      'Pending'; B publishes 'created' for id=x with 'Confirmed'. A's
//      entry is absorbed (no graduate-overwrite); both end up showing
//      Confirmed regardless of A's release outcome.

test('cross-client absorb on success: A optimistic absorbed by B publish', async ({ browser }) => {
	const a = await openQrPage(browser);
	const b = await openQrPage(browser);
	try {
		await a.page.evaluate(() => window.__test.reset());
		await b.page.evaluate(() => window.__test.waitTodos([]));

		await a.page.evaluate(() => window.__test.startBlocked({ token: 'X', kind: 'create', id: 'x', name: 'Pending' }));
		await a.page.evaluate(() => window.__test.waitTodos([{ id: 'x', name: 'Pending' }]));

		await b.page.evaluate(() => window.__test.publish({ event: 'created', id: 'x', name: 'Confirmed' }));
		await a.page.evaluate(() => window.__test.waitTodos([{ id: 'x', name: 'Confirmed' }]));
		await b.page.evaluate(() => window.__test.waitTodos([{ id: 'x', name: 'Confirmed' }]));

		await a.page.evaluate(() => window.__test.release({ token: 'X', success: true }));
		await expectTodos(a.page, [{ id: 'x', name: 'Confirmed' }]);
		await expectTodos(b.page, [{ id: 'x', name: 'Confirmed' }]);
	} finally {
		await a.ctx.close();
		await b.ctx.close();
	}
});

test('cross-client absorb on failure: A optimistic absorbed by B publish; A failure does not roll back B view', async ({ browser }) => {
	const a = await openQrPage(browser);
	const b = await openQrPage(browser);
	try {
		await a.page.evaluate(() => window.__test.reset());
		await b.page.evaluate(() => window.__test.waitTodos([]));

		await a.page.evaluate(() => window.__test.startBlocked({ token: 'X', kind: 'create', id: 'x', name: 'Pending' }));
		await b.page.evaluate(() => window.__test.publish({ event: 'created', id: 'x', name: 'Confirmed' }));
		await a.page.evaluate(() => window.__test.waitTodos([{ id: 'x', name: 'Confirmed' }]));

		await a.page.evaluate(() => window.__test.release({ token: 'X', success: false }));
		// Both still see the server-confirmed value: serverConfirmed entries
		// are dropped on settle regardless of success / failure.
		await expectTodos(a.page, [{ id: 'x', name: 'Confirmed' }]);
		await expectTodos(b.page, [{ id: 'x', name: 'Confirmed' }]);
	} finally {
		await a.ctx.close();
		await b.ctx.close();
	}
});

// 8 -- Late join: B opens after A published; B's initial fetch returns the
//      server _state including A's earlier publishes.

test('late join: B opens after A published; initial fetch shows server state', async ({ browser }) => {
	const a = await openQrPage(browser);
	try {
		await a.page.evaluate(() => window.__test.reset());

		await a.page.evaluate(() => window.__test.publish({ event: 'created', id: 'p1', name: 'P1' }));
		await a.page.evaluate(() => window.__test.publish({ event: 'created', id: 'p2', name: 'P2' }));
		await a.page.evaluate(() => window.__test.waitTodos([
			{ id: 'p1', name: 'P1' }, { id: 'p2', name: 'P2' }
		]));

		// Now open B; its initial fetch should return the same server state.
		const b = await openQrPage(browser);
		try {
			await b.page.evaluate(() => window.__test.waitTodos([
				{ id: 'p1', name: 'P1' }, { id: 'p2', name: 'P2' }
			]));
		} finally {
			await b.ctx.close();
		}
	} finally {
		await a.ctx.close();
	}
});

// 9 -- Late join while A is in queue mode: B sees server-only state
//      (A's local optimistic is NOT visible to B until A releases).

test('late join during in-flight mutate: B sees server state, not A optimistic', async ({ browser }) => {
	const a = await openQrPage(browser);
	try {
		await a.page.evaluate(() => window.__test.reset());

		// Server has one entry already.
		await a.page.evaluate(() => window.__test.publish({ event: 'created', id: 'srv', name: 'S' }));
		await a.page.evaluate(() => window.__test.waitTodos([{ id: 'srv', name: 'S' }]));

		// A starts an in-flight optimistic that is NOT yet on the server.
		await a.page.evaluate(() => window.__test.startBlocked({ token: 'opt', kind: 'create', id: 'opt', name: 'O' }));
		await a.page.evaluate(() => window.__test.waitTodos([
			{ id: 'srv', name: 'S' }, { id: 'opt', name: 'O' }
		]));

		// Open B AFTER A's optimistic has been added to A's local queue.
		const b = await openQrPage(browser);
		try {
			// B should only see the server state, not A's optimistic placeholder.
			await b.page.evaluate(() => window.__test.waitTodos([{ id: 'srv', name: 'S' }]));

			// Release A as success: A graduates locally; B still does not see
			// (because `block` server-side does not publish).
			await a.page.evaluate(() => window.__test.release({ token: 'opt', success: true }));
			await expectTodos(a.page, [{ id: 'srv', name: 'S' }, { id: 'opt', name: 'O' }]);
			await b.page.waitForTimeout(150);
			await expectTodos(b.page, [{ id: 'srv', name: 'S' }]);
		} finally {
			await b.ctx.close();
		}
	} finally {
		await a.ctx.close();
	}
});

// 10 -- Cross-client lock contention: A and B both fire ordered();
//       server's per-key lock serializes both clients into one FIFO queue.

test('cross-client lock: ordered() from two clients serializes via shared lock', async ({ browser }) => {
	const a = await openLockPage(browser);
	const b = await openLockPage(browser);
	try {
		await a.page.evaluate(() => window.__test.reset());

		// Each client fires three ordered() calls in parallel; server-side
		// lock should serialize all SIX into one FIFO queue with no overlap.
		// Each fixture's fireThreeOrdered also reads the log, but those reads
		// happen at different moments (whichever client's 3 calls finish
		// first reads a partial log). Read the FINAL log once both clients'
		// Promise.all has settled.
		await Promise.all([
			a.page.evaluate(() => window.__test.fireThreeOrdered(40)),
			b.page.evaluate(() => window.__test.fireThreeOrdered(40))
		]);
		const log = await a.page.evaluate(() => window.__test.readLog());

		expect(log.length).toBe(6);
		expect(log.map((e) => e.name).sort()).toEqual(['alpha', 'alpha', 'beta', 'beta', 'gamma', 'gamma']);

		// Non-overlap invariant: each entry's start time is at least holdMs
		// (modulo a few ms timer jitter) after the previous one across the
		// FULL log. If the lock did not serialize, two starts would land
		// within the same window.
		const ts = log.map((e) => e.t).slice().sort((x, y) => x - y);
		for (let i = 1; i < ts.length; i++) {
			expect(ts[i] - ts[i - 1]).toBeGreaterThanOrEqual(30);
		}
	} finally {
		await a.ctx.close();
		await b.ctx.close();
	}
});

// 11 -- Cross-client lock with maxWaitMs: A holds the lock; B's bounded
//       call to the same lock-key times out with LOCK_TIMEOUT.

test('cross-client maxWaitMs: A holds lock, B bounded times out', async ({ browser }) => {
	const a = await openLockPage(browser);
	const b = await openLockPage(browser);
	try {
		await a.page.evaluate(() => window.__test.reset());

		// A and B each fire two bounded() calls (4 total) with holdMs=200ms
		// against the same key; server-side maxWaitMs is 30. The first to
		// acquire holds for 200ms; the rest queue and time out.
		const [resA, resB] = await Promise.all([
			a.page.evaluate(() => window.__test.fireBoundedContended(200)),
			b.page.evaluate(() => window.__test.fireBoundedContended(200))
		]);

		const allErrors = [...resA, ...resB].filter((s) => !s.ok);
		expect(allErrors.length).toBeGreaterThanOrEqual(1);
		for (const e of allErrors) expect(e.code).toBe('LOCK_TIMEOUT');
	} finally {
		await a.ctx.close();
		await b.ctx.close();
	}
});

// 12 -- Stress: A publishes 10 different keys rapidly; B sees all 10 in any
//       order. Proves the pub/sub fan-out does not lose events under
//       sustained load.

test('stress: A publishes 10 keys rapidly; B observes all 10', async ({ browser }) => {
	const a = await openQrPage(browser);
	const b = await openQrPage(browser);
	try {
		await a.page.evaluate(() => window.__test.reset());
		await b.page.evaluate(() => window.__test.waitTodos([]));

		await a.page.evaluate(async () => {
			const ps = [];
			for (let i = 0; i < 10; i++) {
				ps.push(window.__test.publish({ event: 'created', id: 'k' + i, name: 'v' + i }));
			}
			await Promise.all(ps);
		});

		const expected = [];
		for (let i = 0; i < 10; i++) expected.push({ id: 'k' + i, name: 'v' + i });
		await b.page.evaluate(
			(e) => window.__test.waitTodos(e),
			expected
		);
		await expectTodos(a.page, expected);
	} finally {
		await a.ctx.close();
		await b.ctx.close();
	}
});

// 13 -- Disconnect/reconnect-style: B closes mid-flight; A keeps publishing;
//       a fresh client (B') opens later and sees the full accumulated server
//       state. (Not a real "reconnect" because each context has its own WS
//       and Playwright closes them cleanly; this is the "B closes, B'
//       arrives later" scenario.)

test('B closes mid-flight; new client B prime sees accumulated server state', async ({ browser }) => {
	const a = await openQrPage(browser);
	const b = await openQrPage(browser);
	try {
		await a.page.evaluate(() => window.__test.reset());
		await b.page.evaluate(() => window.__test.waitTodos([]));

		await a.page.evaluate(() => window.__test.publish({ event: 'created', id: 'before', name: 'B1' }));
		await b.page.evaluate(() => window.__test.waitTodos([{ id: 'before', name: 'B1' }]));

		// B closes; A keeps publishing.
		await b.ctx.close();
		await a.page.evaluate(() => window.__test.publish({ event: 'created', id: 'after', name: 'B2' }));
		await a.page.evaluate(() => window.__test.waitTodos([
			{ id: 'before', name: 'B1' }, { id: 'after', name: 'B2' }
		]));

		// New client opens; sees both entries via initial fetch.
		const bp = await openQrPage(browser);
		try {
			await bp.page.evaluate(() => window.__test.waitTodos([
				{ id: 'before', name: 'B1' }, { id: 'after', name: 'B2' }
			]));
		} finally {
			await bp.ctx.close();
		}
	} finally {
		await a.ctx.close();
	}
});
