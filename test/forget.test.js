// live.forget: right-to-erasure. Covers the in-memory cascade (push, presence
// with grace-timer clear, rate-limit, idempotency reverse index), tenant
// scoping (no cross-tenant / cross-user bleed), the durable store seam
// (resolve-after-confirm + failure surfacing), the PII-free onForget hook, the
// descriptor-completeness guard, and the constant-shape result.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { live, configureForget, _resetForget } from '../src/server.js';
import { _pushRegistry, _wsToPushUserId } from '../src/server/push.js';
import { _presenceRef, _rateLimits } from '../src/server/state.js';
import { _tenantKey, _tenantTopic } from '../src/server/tenant.js';
import { _resetIdempotencyStore } from '../src/server/idempotency.js';
import { _forgetSurfaceNames } from '../src/server/forget.js';
import { setTimer, clearTimer } from '../src/shared/runtime.js';

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
		expect(_forgetSurfaceNames()).toEqual(['push', 'presence', 'rateLimit', 'idempotency']);
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
