import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { live } from '../src/server.js';
import { setRuntimeEnv, resetRuntimeEnv } from '../src/shared/runtime.js';

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(1000);
	setRuntimeEnv({ clock: { monotonic: () => Date.now() } });
});
afterEach(() => { resetRuntimeEnv(); vi.useRealTimers(); });

describe('pending durable idempotency slots', () => {
	it('returns the original committed result to a waiting duplicate', async () => {
		let owner, committed, effects = 0;
		const store = { acquire: vi.fn(async () => {
			if (committed !== undefined) return { result: committed };
			if (owner) return { pending: true };
			owner = true;
			return { acquired: true, commit: async value => { committed = value; }, abort: async () => { owner = false; } };
		}) };
		let release;
		const gate = new Promise(resolve => { release = resolve; });
		const fn = live.idempotent({ store, keyFrom: () => 'same' }, async () => { effects++; await gate; return { value: 42 }; });
		const ctx = { user: { id: 'alice' }, tenantId: 'tenant' };
		const first = fn(ctx, 'body');
		await vi.advanceTimersByTimeAsync(0);
		let result, failure;
		const second = fn(ctx, 'body').then(value => { result = value; }, error => { failure = error; });
		await vi.advanceTimersByTimeAsync(50);
		expect(failure).toBeUndefined(); expect(result).toBeUndefined(); expect(effects).toBe(1);
		release(); await first;
		await vi.advanceTimersByTimeAsync(250); await second;
		expect(result).toEqual({ value: 42 }); expect(effects).toBe(1);
		for (const [, ttl, meta] of store.acquire.mock.calls) {
			expect(ttl).toBe(172800); expect(meta).toEqual({ user: 'alice', tenant: 'tenant' });
		}
	});

	it('returns a bounded retryable result when the owner remains pending', async () => {
		const store = { acquire: vi.fn(async () => ({ pending: true })) };
		const work = vi.fn(); const fn = live.idempotent({ store, keyFrom: () => 'same' }, work);
		let error; const call = fn({ user: { id: 'alice' } }).catch(value => { error = value; });
		await vi.advanceTimersByTimeAsync(4999);
		expect(error).toBeUndefined();
		await vi.advanceTimersByTimeAsync(1);
		expect(error).toMatchObject({ code: 'IDEMPOTENCY_IN_PROGRESS' }); await call;
		expect(work).not.toHaveBeenCalled();
		expect(store.acquire.mock.calls.length).toBeGreaterThan(1);
		expect(store.acquire.mock.calls.length).toBeLessThan(30);
	});

	it('can acquire after an earlier owner aborts without confusing pending with a result', async () => {
		const commit = vi.fn(), abort = vi.fn(); let ready = false;
		const store = { acquire: async () => ready ? { acquired: true, commit, abort } : { pending: true } };
		const work = vi.fn(async () => 'recovered'); const fn = live.idempotent({ store, keyFrom: () => 'same' }, work);
		const call = fn({}).catch(error => error);
		await vi.advanceTimersByTimeAsync(50); ready = true;
		await vi.advanceTimersByTimeAsync(250);
		expect(await call).toBe('recovered'); expect(work).toHaveBeenCalledOnce(); expect(commit).toHaveBeenCalledOnce(); expect(abort).not.toHaveBeenCalled();
	});

	it('still rejects payload reuse when the pending owner eventually commits', async () => {
		let committed;
		const store = { acquire: async () => committed === undefined ? { pending: true } : { result: committed } };
		const original = live.idempotent({ keyFrom: () => 'original', store: { acquire: async () => ({ acquired: true, commit: async value => { committed = value; }, abort: async () => {} }) } }, async () => 'first');
		const duplicate = live.idempotent({ keyFrom: () => 'same', store }, vi.fn());
		const call = duplicate({}, 'different').catch(error => error);
		await vi.advanceTimersByTimeAsync(20); await original({}, 'first');
		await vi.advanceTimersByTimeAsync(250);
		expect(await call).toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
	});

	it('bounds a hung follow-up read and releases only an unused late acquisition', async () => {
		let reads = 0, completeRead;
		const held = new Promise(resolve => { completeRead = resolve; });
		const store = { acquire: async () => ++reads === 1 ? { pending: true } : held };
		const work = vi.fn(), abort = vi.fn(), commit = vi.fn();
		const fn = live.idempotent({ store, keyFrom: () => 'same' }, work);
		let error; const call = fn({}).catch(value => { error = value; });
		await vi.advanceTimersByTimeAsync(5000);
		expect(error).toMatchObject({ code: 'IDEMPOTENCY_IN_PROGRESS' }); expect(reads).toBe(2); await call;
		completeRead({ acquired: true, abort, commit }); await vi.advanceTimersByTimeAsync(0);
		expect(abort).toHaveBeenCalledOnce(); expect(commit).not.toHaveBeenCalled(); expect(work).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
	});

	it('propagates a failed poll without aborting the active owner or leaving a timeout', async () => {
		const failure = Error('store unavailable'); let reads = 0;
		const store = { acquire: async () => { if (++reads === 1) return { pending: true }; throw failure; } };
		const work = vi.fn(); const fn = live.idempotent({ store, keyFrom: () => 'same' }, work);
		const call = fn({}).catch(error => error);
		await vi.advanceTimersByTimeAsync(10);
		expect(await call).toBe(failure); expect(work).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
	});

});
