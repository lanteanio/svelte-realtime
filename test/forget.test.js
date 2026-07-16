// live.forget: right-to-erasure. Covers the in-memory cascade (push, presence
// with grace-timer clear, rate-limit, idempotency reverse index), tenant
// scoping (no cross-tenant / cross-user bleed), the durable store seam
// (resolve-after-confirm + failure surfacing), the PII-free onForget hook, the
// descriptor-completeness guard, and the constant-shape result.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { live, configureForget, _resetForget } from '../src/server.js';
import { _pushRegistry, _wsToPushUserId } from '../src/server/push.js';
import { _presenceRef, _rateLimits } from '../src/server/state.js';
import { _tenantKey, _tenantTopic } from '../src/server/tenant.js';
import { _resetIdempotencyStore } from '../src/server/idempotency.js';
import { _forgetSurfaceNames } from '../src/server/forget.js';
import { _resetReplayRouting } from '../src/server/replay-routing.js';
import { setTimer, clearTimer, setRuntimeEnv, resetRuntimeEnv } from '../src/shared/runtime.js';

// The framework joins key segments with a NUL byte (`_tenantKey`, presence ref
// keys, rate-limit bucket keys). Build it via fromCharCode so the SOURCE stays
// ASCII-clean - a raw NUL in a source file breaks grep / Edit and ships a
// control byte.
const SEP = String.fromCharCode(0);

function resetAll() {
	_pushRegistry.clear();
	_presenceRef.clear();
	_rateLimits.clear();
	_resetIdempotencyStore();
	_resetForget();
}

beforeEach(resetAll);
afterEach(resetAll);

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('live.forget - input validation', () => {
	it('rejects a missing / empty / non-string userId', async () => {
		await expect(live.forget()).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
		await expect(live.forget('')).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
		await expect(live.forget(42)).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
	});

	it('rejects a userId with control chars (topic-unsafe)', async () => {
		await expect(live.forget('a' + String.fromCharCode(10) + 'b')).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
		await expect(live.forget('a' + SEP + 'b')).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
	});

	it('rejects an invalid tenantId and a non-object opts', async () => {
		await expect(live.forget('u1', { tenantId: 'bad tenant!' })).rejects.toBeTruthy();
		await expect(live.forget('u1', 5)).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
		await expect(live.forget('u1', { onForget: 'no' })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
	});
});

describe('live.forget - push registry', () => {
	it('drops the user entry and its ws reverse mapping', async () => {
		const ws = {};
		_pushRegistry.set('u1', { ws, platform: {} });
		_wsToPushUserId.set(ws, 'u1');
		_pushRegistry.set('u2', { ws: {}, platform: {} });

		const res = await live.forget('u1');
		expect(_pushRegistry.has('u1')).toBe(false);
		expect(_wsToPushUserId.has(ws)).toBe(false);
		expect(_pushRegistry.has('u2')).toBe(true);
		expect(res.surfaces.push).toBe(1);
	});

	it('is a no-op (count 0) when the user has no push entry', async () => {
		const res = await live.forget('ghost');
		expect(res.surfaces.push).toBe(0);
		expect(res.rowsAffected).toBe(0);
		expect(res.ok).toBe(true);
	});
});

describe('live.forget - presence', () => {
	it('deletes the user refs in tenant scope, clears the grace timer, leaves others', async () => {
		let fired = false;
		const timer = setTimer(() => { fired = true; }, 10);
		_presenceRef.set(_tenantTopic('t1', 'room') + SEP + 'u1', { count: 1, timer, data: {} });
		_presenceRef.set(_tenantTopic('t1', 'room2') + SEP + 'u1', { count: 1, timer: null, data: {} });
		// Same user, DIFFERENT tenant - must survive a t1 forget.
		_presenceRef.set(_tenantTopic('t2', 'room') + SEP + 'u1', { count: 1, timer: null, data: {} });
		// Different user, same tenant - must survive.
		_presenceRef.set(_tenantTopic('t1', 'room') + SEP + 'u2', { count: 1, timer: null, data: {} });

		const res = await live.forget('u1', { tenantId: 't1' });
		expect(res.surfaces.presence).toBe(2);
		expect(_presenceRef.has(_tenantTopic('t1', 'room') + SEP + 'u1')).toBe(false);
		expect(_presenceRef.has(_tenantTopic('t1', 'room2') + SEP + 'u1')).toBe(false);
		expect(_presenceRef.has(_tenantTopic('t2', 'room') + SEP + 'u1')).toBe(true);
		expect(_presenceRef.has(_tenantTopic('t1', 'room') + SEP + 'u2')).toBe(true);

		await flush();
		await new Promise((r) => setTimeout(r, 20));
		expect(fired).toBe(false); // grace timer was cleared
		clearTimer(timer);
	});

	it('null-tenant forget only touches non-tenant-scoped topics', async () => {
		_presenceRef.set('room' + SEP + 'u1', { count: 1, timer: null, data: {} });
		_presenceRef.set(_tenantTopic('t1', 'room') + SEP + 'u1', { count: 1, timer: null, data: {} });

		const res = await live.forget('u1');
		expect(res.surfaces.presence).toBe(1);
		expect(_presenceRef.has('room' + SEP + 'u1')).toBe(false);
		expect(_presenceRef.has(_tenantTopic('t1', 'room') + SEP + 'u1')).toBe(true);
	});
});

describe('live.forget - rate limits', () => {
	it('drops the user buckets in tenant scope, leaves other users/tenants', async () => {
		// Real bucket key shape: _tenantKey(tenant, path + NUL + userKey).
		_rateLimits.set(_tenantKey('t1', 'rpc:do' + SEP + 'u1'), { windowStart: 0, windowMs: 1000, count: 3 });
		_rateLimits.set(_tenantKey('t1', 'rpc:other' + SEP + 'u1'), { windowStart: 0, windowMs: 1000, count: 1 });
		_rateLimits.set(_tenantKey('t2', 'rpc:do' + SEP + 'u1'), { windowStart: 0, windowMs: 1000, count: 1 });
		_rateLimits.set(_tenantKey('t1', 'rpc:do' + SEP + 'u2'), { windowStart: 0, windowMs: 1000, count: 1 });

		const res = await live.forget('u1', { tenantId: 't1' });
		expect(res.surfaces.rateLimit).toBe(2);
		expect(_rateLimits.has(_tenantKey('t1', 'rpc:do' + SEP + 'u1'))).toBe(false);
		expect(_rateLimits.has(_tenantKey('t1', 'rpc:other' + SEP + 'u1'))).toBe(false);
		expect(_rateLimits.has(_tenantKey('t2', 'rpc:do' + SEP + 'u1'))).toBe(true);
		expect(_rateLimits.has(_tenantKey('t1', 'rpc:do' + SEP + 'u2'))).toBe(true);
	});
});

describe('live.forget - idempotency reverse index', () => {
	it('erases the user cached results so the handler re-runs', async () => {
		let calls = 0;
		const fn = live.idempotent({}, async (ctx, x) => { calls++; return { x }; });
		const ctx = { user: { id: 'u1' }, tenantId: 't1', _idempotencyKey: 'order-1' };

		await fn(ctx, 1);
		await fn(ctx, 1); // cache hit, handler not re-run
		expect(calls).toBe(1);

		const res = await live.forget('u1', { tenantId: 't1' });
		expect(res.surfaces.idempotency).toBe(1);

		await fn(ctx, 1); // entry erased -> handler re-runs
		expect(calls).toBe(2);
	});

	it('a commit racing a concurrent forget is dropped (no re-cache of the forgotten user)', async () => {
		let calls = 0;
		let release;
		const gate = new Promise((r) => { release = r; });
		const fn = live.idempotent({}, async () => { calls++; await gate; return { ok: true }; });
		const ctx = { user: { id: 'u1' }, tenantId: 't1', _idempotencyKey: 'k' };

		const inflight = fn(ctx); // acquires the slot, handler parks at the gate
		await flush();
		expect(calls).toBe(1);

		// Forget the user WHILE the request is in flight (not yet committed).
		await live.forget('u1', { tenantId: 't1' });
		release(); // handler resolves -> commit runs, must be dropped
		await inflight;

		// The forgotten user's result must NOT be cached: a re-run re-executes
		// the handler instead of returning the dropped commit's cached value.
		// (Normal caching is proven by the cache-hit tests above; the tombstone
		// conservatively drops commits through the current clock tick.)
		await fn(ctx);
		expect(calls).toBe(2);
	});

	it('forget tombstone uses MONOTONIC time: a backward wall step cannot resurrect an in-flight commit', async () => {
		let wall = 1000;
		let mono = 1000; // wall and monotonic aligned when the request acquires
		setRuntimeEnv({ clock: { now: () => wall, monotonic: () => mono, wallEpoch: () => wall } });
		try {
			let calls = 0;
			let release;
			const gate = new Promise((r) => { release = r; });
			const fn = live.idempotent({}, async () => { calls++; await gate; return { secret: 'PII' }; });
			const ctx = { user: { id: 'u1' }, tenantId: 't1', _idempotencyKey: 'k' };

			const inflight = fn(ctx); // acquires the slot at monotonic 1000, parks at the gate
			await flush();
			expect(calls).toBe(1);

			// A backward NTP step drags WALL below the acquire time while MONOTONIC
			// advances. A wall tombstone (500 >= 1000 -> false) would RETAIN the erased
			// user's PII; the monotonic tombstone (2000 + grace >= 1000 -> true) drops it.
			wall = 500;
			mono = 2000;
			await live.forget('u1', { tenantId: 't1' }); // tombstone at monotonic 2000
			release();
			await inflight;

			// The forgotten user's result must NOT be cached: a re-run re-executes
			// the handler instead of returning the dropped commit's cached value.
			await fn(ctx);
			expect(calls).toBe(2);
		} finally {
			resetRuntimeEnv();
		}
	});

	it('forget tombstone grace window: drops a duplicate re-acquiring just after the purge, then caches again once past it', async () => {
		let wall = 1000;
		let mono = 1000;
		setRuntimeEnv({ clock: { now: () => wall, monotonic: () => mono, wallEpoch: () => wall } });
		try {
			let calls = 0;
			const fn = live.idempotent({}, async (ctx, x) => { calls++; return { x }; });
			const ctx = { user: { id: 'u1' }, tenantId: 't1', _idempotencyKey: 'k' };

			// Seed a cached result (also creates the default store so forget has a
			// tombstone target).
			await fn(ctx, 1);
			await fn(ctx, 1); // cache hit
			expect(calls).toBe(1);

			// Forget at monotonic 1000: drops the cached entry and sets the tombstone.
			await live.forget('u1', { tenantId: 't1' });

			// A duplicate re-acquiring WITHIN the grace window (500ms after the purge)
			// is still dropped - the deliberate over-drop the old cached-wall clock gave
			// implicitly - so its commit does not re-cache the forgotten user.
			mono = 1500;
			await fn(ctx, 1); // cache miss (forget dropped it), re-runs
			expect(calls).toBe(2);
			await fn(ctx, 1); // within grace: prior commit was dropped, re-runs again
			expect(calls).toBe(3);

			// Past the grace window (2000ms after the purge) the store recovers: a new
			// request caches normally and the next identical call is a cache hit.
			mono = 3000;
			await fn(ctx, 1); // cache miss, re-runs, and now COMMITS (past grace)
			expect(calls).toBe(4);
			await fn(ctx, 1); // cache hit -> handler not re-run
			expect(calls).toBe(4);
		} finally {
			resetRuntimeEnv();
		}
	});

	it('forget tombstone: a duplicate WAITING on an in-flight sibling across a forget must not re-cache forgotten PII', async () => {
		// The racing request here is a DUPLICATE that arrived before live.forget but
		// parked in the inflight-wait loop; when its in-flight sibling is dropped it
		// re-runs AFTER the purge. Its acquire time is snapshotted at arrival (before
		// the wait), so it stays tombstoned even though its re-run and commit land past
		// the grace window - otherwise it would cache the erased user's freshly-computed
		// result for the full TTL (the exact leak idempotency exists to prevent).
		let wall = 1000;
		let mono = 1000;
		setRuntimeEnv({ clock: { now: () => wall, monotonic: () => mono, wallEpoch: () => wall } });
		try {
			let calls = 0;
			let release;
			const gate = new Promise((r) => { release = r; });
			const fn = live.idempotent({}, async () => {
				calls++;
				if (calls === 1) await gate; // only the first (in-flight) call parks
				return { secret: 'PII-' + calls };
			});
			const ctx = { user: { id: 'u1' }, tenantId: 't1', _idempotencyKey: 'k' };

			const r1 = fn(ctx); // acquires at monotonic 1000, parks at the gate
			await flush();
			expect(calls).toBe(1);
			const r2 = fn(ctx); // same key -> parks in the inflight-wait loop (arrival 1000)
			await flush();

			// Forget WHILE both are pending, then advance the clock well past the grace.
			await live.forget('u1', { tenantId: 't1' }); // tombstone at monotonic 1000
			wall = 3000;
			mono = 3000;
			release(); // r1 resolves and is dropped; r2 wakes, re-acquires, re-runs
			await r1;
			await r2;

			// r2 arrived before the forget, so its commit must be dropped: a fresh call
			// re-runs the handler instead of returning r2's forgotten result from cache.
			const r3 = await fn(ctx);
			expect(r3).not.toEqual({ secret: 'PII-2' });
			expect(calls).toBe(3);
		} finally {
			resetRuntimeEnv();
		}
	});

	it('does not erase another user / tenant cached results', async () => {
		let calls = 0;
		const fn = live.idempotent({}, async (ctx, x) => { calls++; return { x }; });
		const ctxA = { user: { id: 'u1' }, tenantId: 't1', _idempotencyKey: 'k' };
		const ctxB = { user: { id: 'u2' }, tenantId: 't1', _idempotencyKey: 'k' };
		await fn(ctxA, 1);
		await fn(ctxB, 1);
		expect(calls).toBe(2);

		await live.forget('u1', { tenantId: 't1' });
		await fn(ctxB, 1); // u2 still cached
		expect(calls).toBe(2);
	});
});

describe('live.forget - durable store seam', () => {
	it('awaits store.purgeUser and folds a numeric count into rowsAffected', async () => {
		let seen = null;
		configureForget({ store: { async purgeUser(tenantId, userId, cascade) { seen = { tenantId, userId, cascade }; return 7; } } });
		const res = await live.forget('u1', { tenantId: 't1' });
		expect(seen).toEqual({ tenantId: 't1', userId: 'u1', cascade: true });
		expect(res.surfaces.durable).toBe(7);
		expect(res.rowsAffected).toBe(7);
	});

	it('folds an object breakdown into a summed durable count', async () => {
		configureForget({ store: { async purgeUser() { return { registry: 2, session: 3 }; } } });
		const res = await live.forget('u1');
		expect(res.surfaces.durable).toBe(5);
	});

	it('surfaces a durable failure as FORGET_STORE_FAILED (incomplete erasure must be retried)', async () => {
		configureForget({ store: { async purgeUser() { throw new Error('redis down'); } } });
		await expect(live.forget('u1')).rejects.toMatchObject({ code: 'FORGET_STORE_FAILED' });
	});

	it('runs with no durable store wired (single-instance)', async () => {
		_pushRegistry.set('u1', { ws: {}, platform: {} });
		const res = await live.forget('u1');
		expect(res.surfaces.durable).toBeUndefined();
		expect(res.rowsAffected).toBe(1);
	});
});

describe('live.forget - durable store owner-succession envelope', () => {
	beforeEach(() => { _resetReplayRouting(); });
	afterEach(() => { _resetReplayRouting(); });

	it('publishes each store-reported succession on the room :owner topic and folds the counts', async () => {
		// The store evicted the erased user as owner of two rooms cluster-wide
		// (rooms this instance holds no local refs for) and reports the changes.
		const published = [];
		const platform = { publish: (t, e, d) => published.push({ t, e, d }) };
		configureForget({
			platform,
			store: {
				async purgeUser() {
					return {
						rowsAffected: { registry: 2, session: 1 },
						ownerSuccessions: [
							{ topic: 'board/1', owner: 'u2', reason: 'succeeded' },
							{ topic: 'board/2', owner: null, reason: 'vacated' }
						]
					};
				}
			}
		});
		const res = await live.forget('u1');
		expect(res.surfaces.durable).toBe(3);
		expect(res.surfaces.ownerSuccessions).toBe(2);
		// The successor (and the vacated null) reach subscribers on every replica
		// via the :owner wire event - the value a connected room.owner store shows.
		expect(published).toContainEqual({ t: 'board/1:owner', e: 'set', d: { key: 'u2', reason: 'succeeded' } });
		expect(published).toContainEqual({ t: 'board/2:owner', e: 'set', d: { key: null, reason: 'vacated' } });
	});

	it('routes a store-reported succession through the :owner replay buffer so a resumer gap-fills the successor', async () => {
		// Mirrors the F3 fix: the forgetting instance need not hold a local :owner
		// subscriber, so the topic is registered replay-eligible and the emit lands
		// in the shared buffer, not only on the live bus.
		const buffered = [];
		const bare = [];
		const platform = {
			publish: (t, e, d) => bare.push({ t, e, d }),
			replay: {
				publish: (_p, topic, event, data) => { buffered.push({ topic, event, data }); return Promise.resolve(); },
				since: async () => [],
				seq: async () => 0
			}
		};
		configureForget({
			platform,
			store: { async purgeUser() { return { rowsAffected: 1, ownerSuccessions: [{ topic: 'board/9', owner: 'u3', reason: 'succeeded' }] }; } }
		});
		const res = await live.forget('u1');
		expect(res.surfaces.ownerSuccessions).toBe(1);
		expect(buffered).toContainEqual({ topic: 'board/9:owner', event: 'set', data: { key: 'u3', reason: 'succeeded' } });
		expect(bare).toEqual([]); // routed through the buffer, not the bare publish
	});

	it('a plain count return (no envelope) stays byte-identical - no ownerSuccessions surface', async () => {
		configureForget({ store: { async purgeUser() { return { registry: 2, session: 3 }; } } });
		const res = await live.forget('u1');
		expect(res.surfaces.durable).toBe(5);
		expect('ownerSuccessions' in res.surfaces).toBe(false);
	});

	it('skips malformed succession entries and defaults a missing reason to succeeded', async () => {
		const published = [];
		const platform = { publish: (t, e, d) => published.push({ t, e, d }) };
		configureForget({
			platform,
			store: {
				async purgeUser() {
					return { rowsAffected: 0, ownerSuccessions: [null, {}, { topic: '' }, { topic: 'room/1', owner: 'u2' }] };
				}
			}
		});
		const res = await live.forget('u1');
		expect(res.surfaces.ownerSuccessions).toBe(1);
		expect(published).toEqual([{ t: 'room/1:owner', e: 'set', d: { key: 'u2', reason: 'succeeded' } }]);
	});

	it('an envelope with no platform wired publishes nothing and reports zero (no throw)', async () => {
		configureForget({ store: { async purgeUser() { return { rowsAffected: 4, ownerSuccessions: [{ topic: 'board/1', owner: 'u2', reason: 'succeeded' }] }; } } });
		configureForget({ platform: null });
		const res = await live.forget('u1');
		expect(res.surfaces.durable).toBe(4);
		expect(res.surfaces.ownerSuccessions).toBe(0);
	});

	it('a throwing publish never fails the forget - the durable erasure already confirmed', async () => {
		// The store committed the eviction; the wire announcement is best-effort.
		// A broken bus must not surface as FORGET_STORE_FAILED, which would tell
		// the caller to retry an erasure that succeeded.
		configureForget({
			platform: { publish: () => { throw new Error('bus down'); } },
			store: { async purgeUser() { return { rowsAffected: 2, ownerSuccessions: [{ topic: 'board/1', owner: 'u2', reason: 'succeeded' }] }; } }
		});
		const res = await live.forget('u1');
		expect(res.ok).toBe(true);
		expect(res.surfaces.durable).toBe(2);
	});

	it('announces a succession the store COMMITTED before a sibling room failed, on the incomplete-erasure path', async () => {
		// The store evicted the erased user as owner of one room (committed
		// durably) but a sibling room hit a transient error, so purgeUser rejects
		// to force a retry and carries the committed succession on the error. It
		// must still reach the wire now: the retry finds the committed room already
		// handed off (o != userId in-script) and reports nothing for it, so this is
		// the only chance to announce it to already-subscribed clients.
		const published = [];
		const platform = { publish: (t, e, d) => published.push({ t, e, d }) };
		configureForget({
			platform,
			store: {
				async purgeUser() {
					const err = new Error('createForgetStore: 1 of 3 store(s) failed to purge; incomplete');
					/** @type {any} */ (err).ownerSuccessions = [{ topic: 'board/1', owner: 'u2', reason: 'succeeded' }];
					/** @type {any} */ (err).failures = [new Error('Connection is closed')];
					throw err;
				}
			}
		});
		// The erasure is still signalled incomplete (the sibling room must retry)...
		await expect(live.forget('u1')).rejects.toMatchObject({ code: 'FORGET_STORE_FAILED' });
		// ...yet the committed room's successor already reached subscribers.
		expect(published).toContainEqual({ t: 'board/1:owner', e: 'set', d: { key: 'u2', reason: 'succeeded' } });
	});

	it('a throwing publish on the failure path still rejects as FORGET_STORE_FAILED, not the bus error', async () => {
		// The announce-on-failure is best-effort and fully guarded: a broken bus
		// must not mask FORGET_STORE_FAILED, which is what tells the caller the
		// partially-failed erasure still needs a retry.
		configureForget({
			platform: { publish: () => { throw new Error('bus down'); } },
			store: {
				async purgeUser() {
					const err = new Error('incomplete');
					/** @type {any} */ (err).ownerSuccessions = [{ topic: 'board/1', owner: 'u2', reason: 'succeeded' }];
					throw err;
				}
			}
		});
		await expect(live.forget('u1')).rejects.toMatchObject({ code: 'FORGET_STORE_FAILED' });
	});

	it('routes a COMMITTED succession through the :owner replay buffer on the failure path too (resumer gap-fills the successor, not the erased owner)', async () => {
		// Success-path parity for the incomplete-erasure announcement: the emit must
		// land in the shared buffer, not only the live bus, or a client resuming
		// after the partial forget would gap-fill the ERASED owner from a stale
		// buffer instead of the committed successor.
		const buffered = [];
		const bare = [];
		const platform = {
			publish: (t, e, d) => bare.push({ t, e, d }),
			replay: {
				publish: (_p, topic, event, data) => { buffered.push({ topic, event, data }); return Promise.resolve(); },
				since: async () => [],
				seq: async () => 0
			}
		};
		configureForget({
			platform,
			store: {
				async purgeUser() {
					const err = new Error('1 of 2 store(s) failed to purge; incomplete');
					/** @type {any} */ (err).ownerSuccessions = [{ topic: 'board/9', owner: 'u3', reason: 'succeeded' }];
					throw err;
				}
			}
		});
		await expect(live.forget('u1')).rejects.toMatchObject({ code: 'FORGET_STORE_FAILED' });
		expect(buffered).toContainEqual({ topic: 'board/9:owner', event: 'set', data: { key: 'u3', reason: 'succeeded' } });
		expect(bare).toEqual([]); // buffer, not bare
	});

	it('redacts the successor ids from the dev diagnostic on the incomplete-erasure path (no PII in logs)', async () => {
		// The committed successions carry SUCCESSOR user ids (other users); the
		// purgeUser-threw diagnostic must log the failure reasons but never those ids
		// (credo: no PII in logs). Guards against a regression that logs the raw error.
		const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		try {
			configureForget({
				platform: { publish: () => {} },
				store: {
					async purgeUser() {
						const err = new Error('1 of 2 store(s) failed to purge; incomplete');
						/** @type {any} */ (err).ownerSuccessions = [{ topic: 'board/1', owner: 'secret-successor-id', reason: 'succeeded' }];
						/** @type {any} */ (err).failures = [new Error('Connection is closed')];
						throw err;
					}
				}
			});
			await expect(live.forget('u1')).rejects.toMatchObject({ code: 'FORGET_STORE_FAILED' });
			const logged = JSON.stringify(errSpy.mock.calls);
			expect(logged).not.toContain('secret-successor-id');
			expect(logged).not.toContain('ownerSuccessions');
		} finally {
			errSpy.mockRestore();
		}
	});
});

describe('live.forget - onForget audit hook', () => {
	it('receives a HASHED userId (never the raw id) plus tenant/cascade/counts', async () => {
		_pushRegistry.set('u1', { ws: {}, platform: {} });
		let rec = null;
		await live.forget('u1', { tenantId: 't1', onForget: (r) => { rec = r; } });
		expect(rec).toBeTruthy();
		expect(rec.userIdHash).toMatch(/^[0-9a-f]{32}$/);
		expect(rec.userIdHash).not.toBe('u1');
		expect(rec.tenantId).toBe('t1');
		expect(rec.cascade).toBe(true);
		expect(rec.rowsAffected).toBe(1);
		expect(rec.surfaces.push).toBe(1);
	});

	it('a throwing onForget never aborts a completed erasure', async () => {
		_pushRegistry.set('u1', { ws: {}, platform: {} });
		const res = await live.forget('u1', { onForget: () => { throw new Error('hook boom'); } });
		expect(res.ok).toBe(true);
		expect(_pushRegistry.has('u1')).toBe(false);
	});
});

describe('live.forget - shape + descriptors', () => {
	it('always returns the constant ok:true shape with an at timestamp', async () => {
		const res = await live.forget('nobody');
		expect(res.ok).toBe(true);
		expect(typeof res.at).toBe('number');
		expect(res.rowsAffected).toBe(0);
	});

	it('the descriptor table covers every known in-memory user-keyed surface', () => {
		expect(_forgetSurfaceNames()).toEqual([
			'push', 'presence', 'rateLimit', 'idempotency',
			'smooth', 'webhookDeadLetter', 'aggregateCohorts'
		]);
	});

	it('every identity-annotated collection in src/server is classified (reflective completeness guard)', async () => {
		// The forget-completeness security requirement: a new user-keyed
		// in-memory store must not appear without a purge descriptor. This scan
		// finds module/factory collections whose adjacent doc comment speaks of
		// identities/user ids and requires each FILE to be classified below -
		// either purged through a named descriptor or exempt with a reason. A
		// new file (or a newly annotated collection in an unclassified file)
		// fails here until someone classifies it.
		const fs = await import('node:fs');
		const path = await import('node:path');
		const dir = path.join(process.cwd(), 'src', 'server');
		const collectionRe = /new (Weak)?(Map|Set)\(/;
		const identityRe = /identity|user\s?id|userid|by user|per user|per-user/i;

		/** file -> descriptor name that purges it, or 'exempt: <reason>' */
		const classified = {
			'push.js': 'push',
			'interest.js': 'smooth', // purged through the smooth descriptor (rec.interest.purgeIdentity)
			'smooth.js': 'smooth',
			'lagcomp.js': 'smooth', // purged through the smooth descriptor (rec.lagComp.remove)
			'room-owner.js': 'presence', // the owner role releases inside the presence purge
			'rate-limit.js': 'rateLimit',
			'idempotency.js': 'idempotency',
			'dead-letter.js': 'webhookDeadLetter',
			'reactive.js': 'aggregateCohorts',
			'presence.js': 'presence'
		};
		const descriptorNames = new Set(_forgetSurfaceNames());

		const unclassified = [];
		for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.js'))) {
			const lines = fs.readFileSync(path.join(dir, file), 'utf8').split('\n');
			let flagged = false;
			for (let i = 0; i < lines.length && !flagged; i++) {
				if (!collectionRe.test(lines[i])) continue;
				let ctx = '';
				for (let j = i - 1; j >= 0 && j >= i - 8; j--) {
					const t = lines[j].trim();
					if (t.startsWith('*') || t.startsWith('//') || t.startsWith('/*')) ctx = t + '\n' + ctx;
					else break;
				}
				if (identityRe.test(ctx)) flagged = true;
			}
			if (!flagged) continue;
			const cls = classified[file];
			if (cls === undefined) {
				unclassified.push(file);
			} else if (!cls.startsWith('exempt:')) {
				// A classification naming a descriptor must name a REAL one.
				expect(descriptorNames.has(cls), file + ' claims descriptor "' + cls + '" which does not exist').toBe(true);
			}
		}
		expect(unclassified, 'identity-keyed collections without a forget classification: add a purge descriptor (and classify the file here) or an exempt entry with a reason').toEqual([]);
	});
});

describe('configureForget - validation', () => {
	it('rejects a store without purgeUser and an empty config', () => {
		expect(() => configureForget({ store: {} })).toThrow();
		expect(() => configureForget({})).toThrow();
		expect(() => configureForget(5)).toThrow();
	});

	it('null clears the store (subsequent forget runs in-memory only)', async () => {
		configureForget({ store: { async purgeUser() { return 1; } } });
		configureForget(null);
		const res = await live.forget('u1');
		expect(res.surfaces.durable).toBeUndefined();
	});
});

describe('live.forget - smooth/game state', () => {
	afterEach(async () => {
		const { _smoothTopics } = await import('../src/server/smooth.js');
		_smoothTopics.clear();
	});

	it('purges the registry entry, surrogates, interest state, and lag-comp ring', async () => {
		const { _smoothTopics } = await import('../src/server/smooth.js');
		const { createInterestState } = await import('../src/server/interest.js');

		const ws = {};
		const interest = createInterestState({ radius: 100 });
		interest.reportCenter('u1', 10, 20);
		interest.reportCenter('u2', 30, 40);
		const rings = new Map([['u1', {}], ['e9', {}]]);
		const rec = {
			registry: new Map([['u1', ws], ['u2', {}]]),
			surrogates: new Map([
				['inst-a' + SEP + 'u1', { s: 1 }],
				['inst-a' + SEP + 'u2', { s: 2 }]
			]),
			interest,
			lagComp: { get size() { return rings.size; }, remove: (k) => rings.delete(k) }
		};
		_smoothTopics.set('arena', rec);

		const res = await live.forget('u1');

		expect(rec.registry.has('u1')).toBe(false);
		expect(rec.registry.has('u2')).toBe(true);
		expect(rec.surrogates.has('inst-a' + SEP + 'u1')).toBe(false);
		expect(rec.surrogates.has('inst-a' + SEP + 'u2')).toBe(true);
		expect(rings.has('u1')).toBe(false);
		expect(rings.has('e9')).toBe(true);
		expect(res.surfaces.smooth).toBeGreaterThanOrEqual(3); // registry + surrogate + interest + ring
		// The other user's interest center survives (snapshot for u2 still centered).
		expect(interest.snapshotFor('u2', [])).toEqual([]);
	});
});

describe('live.forget - webhook dead-letter queue', () => {
	afterEach(async () => {
		const { configureWebhooks } = await import('../src/server.js');
		configureWebhooks({ deadLetter: false });
	});

	it('purges dead-lettered events stamped by the forgetUserId extractor', async () => {
		const { configureWebhooks, createDeadLetterStore } = await import('../src/server.js');
		const store = createDeadLetterStore({ forgetUserId: ({ data }) => data && data.author });
		configureWebhooks({ deadLetter: store });
		store.add({ webhookId: 'wh1', topic: 't', event: 'e', data: { author: 'u1', body: 'x' }, attempts: 3, error: 'down' });
		store.add({ webhookId: 'wh1', topic: 't', event: 'e', data: { author: 'u2', body: 'y' }, attempts: 3, error: 'down' });
		store.add({ webhookId: 'wh1', topic: 't', event: 'e', data: { body: 'unattributed' }, attempts: 3, error: 'down' });

		const res = await live.forget('u1');

		expect(res.surfaces.webhookDeadLetter).toBe(1);
		expect(store.count()).toBe(2);
		expect(store.list().every((r) => r.userId !== 'u1')).toBe(true);
	});

	it('reports 0 for a store without purgeUser (documented limitation, no throw)', async () => {
		const { configureWebhooks } = await import('../src/server.js');
		configureWebhooks({ deadLetter: { add: () => '1', get: () => null, remove: () => false, count: () => 0, list: () => [], summary: () => ({}), clear: () => {} } });
		const res = await live.forget('u1');
		expect(res.surfaces.webhookDeadLetter).toBe(0);
	});
});

describe('live.forget - aggregate k-anonymity cohorts', () => {
	afterEach(async () => {
		const { _aggregateBySource } = await import('../src/server/state.js');
		_aggregateBySource.clear();
	});

	it('withdraws the user from single-state, window, and hop-bucket cohorts', async () => {
		const { _aggregateBySource } = await import('../src/server/state.js');
		const entry = {
			cohort: new Set(['u1', 'u2']),
			windowStates: new Map([
				['w1', { cohort: new Set(['u1', 'u3']) }],
				['w2', { bucketCohorts: [new Set(['u1']), new Set(['u2', 'u1'])] }]
			])
		};
		// The same entry registered under two source topics counts once.
		_aggregateBySource.set('topic-a', [entry]);
		_aggregateBySource.set('topic-b', [entry]);

		const res = await live.forget('u1');

		expect(res.surfaces.aggregateCohorts).toBe(4);
		expect(entry.cohort.has('u1')).toBe(false);
		expect(entry.cohort.has('u2')).toBe(true);
		expect(entry.windowStates.get('w1').cohort.has('u1')).toBe(false);
		expect(entry.windowStates.get('w2').bucketCohorts[0].size).toBe(0);
		expect(entry.windowStates.get('w2').bucketCohorts[1].has('u2')).toBe(true);
	});
});

describe('live.forget - cascade.crdt whole-document drop', () => {
	afterEach(async () => {
		const { _crdtDecls } = await import('../src/server/crdt.js');
		_crdtDecls.clear();
	});

	it('validates the cascade shape', async () => {
		await expect(live.forget('u1', { cascade: 5 })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
		await expect(live.forget('u1', { cascade: { crdt: 'not-array' } })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
		await expect(live.forget('u1', { cascade: { crdt: ['ok', ''] } })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
		await expect(live.forget('u1', { cascade: true })).resolves.toMatchObject({ ok: true });
		await expect(live.forget('u1', { cascade: { crdt: [] } })).resolves.toMatchObject({ ok: true });
	});

	it('drops named documents through the authority and counts them', async () => {
		const { _crdtDecls } = await import('../src/server/crdt.js');
		const dropped = [];
		_crdtDecls.set('decl-1', {
			key: 'decl-1',
			authority: { drop: (t) => { dropped.push(t); return t === 'notes:42'; } }
		});

		const res = await live.forget('u1', { cascade: { crdt: ['notes:42', 'notes:404'] } });

		expect(dropped).toEqual(['notes:42', 'notes:404']);
		expect(res.surfaces.crdtDocs).toBe(1);
		expect(res.rowsAffected).toBeGreaterThanOrEqual(1);
	});

	it('reports 0 when the adapter authority has no drop()', async () => {
		const { _crdtDecls } = await import('../src/server/crdt.js');
		_crdtDecls.set('decl-1', { key: 'decl-1', authority: {} });
		const res = await live.forget('u1', { cascade: { crdt: ['notes:42'] } });
		expect(res.surfaces.crdtDocs).toBe(0);
	});
});

describe('live.forget - cross-socket push sessions', () => {
	it('drains session entries the user holds on sockets other than the routing socket', async () => {
		const { _pushSessionRegistry, _wsToPushSessionId } = await import('../src/server/push.js');
		const primaryWs = {};
		const otherWs = {};
		_pushRegistry.set('u1', { ws: primaryWs, platform: {} });
		_wsToPushUserId.set(primaryWs, 'u1');
		// A session the user registered from ANOTHER socket (superseded routing).
		_wsToPushUserId.set(otherWs, 'u1');
		_pushSessionRegistry.set('sess-other', { ws: otherWs, platform: {} });
		_wsToPushSessionId.set(otherWs, 'sess-other');
		// An unrelated user's session survives.
		const strangerWs = {};
		_wsToPushUserId.set(strangerWs, 'u2');
		_pushSessionRegistry.set('sess-stranger', { ws: strangerWs, platform: {} });
		_wsToPushSessionId.set(strangerWs, 'sess-stranger');

		const res = await live.forget('u1');

		expect(_pushRegistry.has('u1')).toBe(false);
		expect(_pushSessionRegistry.has('sess-other')).toBe(false);
		expect(_pushSessionRegistry.has('sess-stranger')).toBe(true);
		expect(res.surfaces.push).toBe(2);

		_pushSessionRegistry.clear();
	});
});
