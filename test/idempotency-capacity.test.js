import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { live, _resetForget, _resetIdempotencyStore } from '../src/server.js';
import { createTestEnv } from '../src/testing.js';
import { setRuntimeEnv, resetRuntimeEnv } from '../src/shared/runtime.js';
import { _setTenantResolver, _resetTenantResolver } from '../src/server/tenant.js';

const CAPACITY = 1000;
const GLOBAL = 10000;
const RESERVE = 1000;
const capacityError = { code: 'IDEMPOTENCY_CAPACITY' };
function deferred() {
	let resolve;
	const promise = new Promise(done => { resolve = done; });
	return { promise, resolve };
}

describe('idempotency capacity preserves accepted effects', () => {
	let env, clock, gates;
	beforeEach(() => {
		_resetIdempotencyStore(); _resetForget();
		clock = 1000; gates = [];
		setRuntimeEnv({ clock: { now: () => clock, monotonic: () => clock, wallEpoch: () => clock } });
	});
	afterEach(() => {
		for (const gate of gates) gate.resolve();
		env?.cleanup(); env = null;
		_resetIdempotencyStore(); _resetForget(); _resetTenantResolver(); resetRuntimeEnv();
	});

	it.each([true, false])('rejects hostile tenant churn before its effect and permits fresh honest work (identified: %s)', async identified => {
		_setTenantResolver(user => user.tenant);
		env = createTestEnv();
		const effects = new Map();
		env.register('work', { run: live.idempotent({ keyFrom: (ctx, key) => key }, async (ctx, key) => {
			const id = ctx.tenantId + ':' + key;
			const count = (effects.get(id) || 0) + 1; effects.set(id, count);
			return count;
		}) });
		const honest = env.connect(identified ? { id: 'same-user', tenant: 'honest' } : { tenant: 'honest' });
		const hostile = env.connect(identified ? { id: 'same-user', tenant: 'hostile' } : { tenant: 'hostile' });
		expect(await honest.call('work/run', 'paid')).toBe(1);
		for (let i = 0; i < CAPACITY; i++) await hostile.call('work/run', String(i));
		const overflow = await hostile.call('work/run', 'overflow').catch(error => error);
		expect(await honest.call('work/run', 'paid')).toBe(1);
		expect(await honest.call('work/run', 'fresh')).toBe(1);
		expect(effects.get('honest:paid')).toBe(1);
		expect(overflow).toMatchObject(capacityError);
		expect(effects.has('hostile:overflow')).toBe(false);
		expect(await hostile.call('work/run', '0')).toBe(1);
	});

	it('protects a global reserve for tenants below one hundred entries', async () => {
		const run = live.idempotent({ keyFrom: (ctx, key) => key }, async (ctx, key) => key);
		for (let tenant = 0; tenant < 9; tenant++) {
			const ctx = { user: { id: 'member' }, tenantId: String(tenant) };
			for (let i = 0; i < CAPACITY; i++) await run(ctx, String(i));
		}
		const fresh = { user: { id: 'member' }, tenantId: 'fresh' };
		for (let i = 0; i < 100; i++) await expect(run(fresh, String(i))).resolves.toBe(String(i));
		await expect(run(fresh, 'overflow')).rejects.toMatchObject(capacityError);
		await expect(run({ user: { id: 'member' }, tenantId: 'other' }, 'new')).resolves.toBe('new');
		await expect(run({ user: { id: 'member' }, tenantId: '0' }, '0')).resolves.toBe('0');
	});

	it('gives calls without a tenant the whole store', async () => {
		const run = live.idempotent({ keyFrom: (ctx, key) => key }, async (ctx, key) => key);
		const ctx = { user: { id: 'member' } };
		for (let i = 0; i < GLOBAL; i++) await run(ctx, String(i));
		await expect(run(ctx, 'overflow')).rejects.toMatchObject(capacityError);
		await expect(run({ user: { id: 'other' } }, 'new')).rejects.toMatchObject(capacityError);
		await expect(run(ctx, '0')).resolves.toBe('0');
	});

	it('caps calls a tenant resolver leaves unscoped as one bucket', async () => {
		_setTenantResolver(user => user.tenant ?? null);
		const run = live.idempotent({ keyFrom: (ctx, key) => key }, async (ctx, key) => key);
		const anonymous = { user: null };
		for (let i = 0; i < CAPACITY; i++) await run(anonymous, String(i));
		await expect(run(anonymous, 'overflow')).rejects.toMatchObject(capacityError);
		await expect(run({ user: { id: 'member' }, tenantId: 'paid' }, 'first')).resolves.toBe('first');
	});

	it('keeps calls without a tenant out of the reserve while a tenant holds slots', async () => {
		const run = live.idempotent({ keyFrom: (ctx, key) => key }, async (ctx, key) => key);
		const small = { user: { id: 'member' }, tenantId: 'small' };
		await run(small, 'first');
		const plain = { user: { id: 'member' } };
		for (let i = 0; i < GLOBAL - RESERVE - 1; i++) await run(plain, String(i));
		await expect(run(plain, 'overflow')).rejects.toMatchObject(capacityError);
		for (let i = 0; i < 99; i++) await expect(run(small, String(i))).resolves.toBe(String(i));
		await expect(run(small, 'overflow')).rejects.toMatchObject(capacityError);
		await expect(run({ user: { id: 'member' }, tenantId: 'fresh' }, 'new')).resolves.toBe('new');
	});

	for (const ttl of [0, 60]) {
		it(`reserves capacity for concurrent pending handlers with TTL ${ttl}`, async () => {
			const gate = deferred(); gates.push(gate);
			let effects = 0;
			const run = live.idempotent({ ttl, keyFrom: (ctx, key) => key }, async () => { effects++; await gate.promise; return effects; });
			const ctx = { user: { id: 'member' } };
			const pending = Array.from({ length: GLOBAL }, (_, i) => run(ctx, String(i)));
			await nextTurn();
			const duplicate = ttl > 0 ? run(ctx, '0') : null;
			const overflow = run(ctx, 'overflow').catch(error => error);
			await nextTurn();
			expect(effects).toBe(GLOBAL);
			gate.resolve(); await Promise.all(pending);
			if (duplicate) expect(await duplicate).toBe(GLOBAL);
			expect(await overflow).toMatchObject(capacityError);
			if (ttl === 0) await expect(run(ctx, 'fresh')).resolves.toBe(GLOBAL + 1);
			else await expect(run(ctx, 'fresh')).rejects.toMatchObject(capacityError);
		});
	}

	it('releases an aborted reservation without dropping another accepted result', async () => {
		const gate = deferred(); gates.push(gate);
		const run = live.idempotent({ keyFrom: (ctx, key) => key }, async (ctx, key) => {
			if (key === 'abort') { await gate.promise; throw Error('handler failed'); }
			return key;
		});
		const ctx = { user: { id: 'member' } };
		for (let i = 0; i < GLOBAL - 1; i++) await run(ctx, String(i));
		const pending = run(ctx, 'abort').catch(error => error);
		await nextTurn();
		await expect(run(ctx, 'overflow')).rejects.toMatchObject(capacityError);
		gate.resolve(); expect((await pending).message).toBe('handler failed');
		await expect(run(ctx, 'fresh')).resolves.toBe('fresh');
		await expect(run(ctx, '0')).resolves.toBe('0');
	});

	it('reclaims expired results under pressure before the periodic sweep is due', async () => {
		const run = live.idempotent({ ttl: 1, keyFrom: (ctx, key) => key }, async (ctx, key) => key);
		const ctx = { user: { id: 'member' } };
		for (let i = 0; i < GLOBAL; i++) await run(ctx, String(i));
		clock += 1001;
		await expect(run(ctx, 'fresh')).resolves.toBe('fresh');
	});

	it('releases erased cached results for new admission', async () => {
		const run = live.idempotent({ keyFrom: (ctx, key) => ctx.user.id + ':' + key }, async (ctx, key) => key);
		const alice = { user: { id: 'alice' } }, bob = { user: { id: 'bob' } };
		await run(alice, 'erase');
		for (let i = 0; i < GLOBAL - 1; i++) await run(bob, String(i));
		await expect(run(bob, 'overflow')).rejects.toMatchObject(capacityError);
		await live.forget('alice');
		await expect(run(bob, 'fresh')).resolves.toBe('fresh');
	});
});
