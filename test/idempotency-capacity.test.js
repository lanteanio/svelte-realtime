import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { live, _resetForget, _resetIdempotencyStore } from '../src/server.js';
import { createTestEnv } from '../src/testing.js';
import { setRuntimeEnv, resetRuntimeEnv } from '../src/shared/runtime.js';
import { state } from '../src/server/state.js';
import { _setTenantResolver, _resetTenantResolver } from '../src/server/tenant.js';

const GLOBAL = 10000;
const TENANT = 1000;
const capacityError = { code: 'IDEMPOTENCY_CAPACITY' };
function deferred() {
	let resolve;
	const promise = new Promise(done => { resolve = done; });
	return { promise, resolve };
}

// Fill `count` slots from callers that each stay below every reserve
// threshold (a hundredth of their share), so only the shared totals limit them.
async function fill(run, count, base = {}, per = base.tenantId ? 9 : 99) {
	for (let i = 0; i < count; i++) {
		await run({ ...base, user: { id: 'filler' + Math.floor(i / per) } }, 'f' + i);
	}
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
		state.metricsInstruments = null;
		_resetIdempotencyStore(); _resetForget(); _resetTenantResolver(); resetRuntimeEnv();
	});

	function counted() {
		const effects = new Map();
		const run = live.idempotent({ keyFrom: (ctx, key) => key }, async (ctx, key) => {
			const id = (ctx.tenantId ?? '') + ':' + (ctx.user?.id ?? '') + ':' + key;
			const count = (effects.get(id) || 0) + 1; effects.set(id, count);
			return count;
		});
		return { effects, run };
	}

	it.each([true, false])('keeps another tenant\'s cached result through ten thousand hostile keys (identified: %s)', async identified => {
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
		for (let i = 0; i < GLOBAL; i++) expect(await hostile.call('work/run', String(i))).toBe(1);
		expect(await honest.call('work/run', 'paid')).toBe(1);
		expect(effects.get('honest:paid')).toBe(1);
		expect(await honest.call('work/run', 'fresh')).toBe(1);
		// The hostile caller gave up only its own oldest results.
		expect(await hostile.call('work/run', String(GLOBAL - 1))).toBe(1);
		expect(await hostile.call('work/run', '0')).toBe(2);
	});

	it('keeps one identity from crowding out another in an app without tenants', async () => {
		const { effects, run } = counted();
		const alice = { user: { id: 'alice' } }, bob = { user: { id: 'bob' } };
		expect(await run(bob, 'early')).toBe(1);
		for (let i = 0; i < GLOBAL; i++) await run(alice, String(i));
		expect(await run(bob, 'early')).toBe(1);
		expect(await run(bob, 'fresh')).toBe(1);
		expect(await run(alice, String(GLOBAL - 1))).toBe(1);
		expect(effects.get(':alice:0')).toBe(1);
		expect(await run(alice, '0')).toBe(2);
	});

	it('divides a tenant\'s share between its identities', async () => {
		_setTenantResolver(user => user.tenant);
		const { run } = counted();
		const alice = { user: { id: 'alice' }, tenantId: 'acme' }, bob = { user: { id: 'bob' }, tenantId: 'acme' };
		expect(await run(bob, 'early')).toBe(1);
		for (let i = 0; i < TENANT; i++) await run(alice, String(i));
		expect(await run(bob, 'early')).toBe(1);
		expect(await run(bob, 'fresh')).toBe(1);
		expect(await run(alice, '0')).toBe(2);
	});

	it('charges anonymous callers per connection', async () => {
		env = createTestEnv();
		const effects = new Map();
		env.register('work', { run: live.idempotent({ keyFrom: (ctx, key) => key }, async (ctx, key) => {
			const count = (effects.get(key) || 0) + 1; effects.set(key, count);
			return count;
		}) });
		const quiet = env.connect({});
		const noisy = env.connect({});
		expect(await quiet.call('work/run', 'quiet')).toBe(1);
		for (let i = 0; i < GLOBAL; i++) await noisy.call('work/run', 'noisy' + i);
		expect(await quiet.call('work/run', 'quiet')).toBe(1);
		expect(await quiet.call('work/run', 'quiet-fresh')).toBe(1);
		expect(await noisy.call('work/run', 'noisy0')).toBe(2);
	});

	it('refuses a caller whose share is all running handlers, before its handler runs', async () => {
		const gate = deferred(); gates.push(gate);
		let effects = 0;
		const run = live.idempotent({ keyFrom: (ctx, key) => key }, async () => { effects++; await gate.promise; return effects; });
		const alice = { user: { id: 'alice' } };
		const pending = Array.from({ length: TENANT }, (_, i) => run(alice, String(i)));
		await nextTurn();
		await expect(run(alice, 'overflow')).rejects.toMatchObject(capacityError);
		expect(effects).toBe(TENANT);
		const bob = run({ user: { id: 'bob' } }, 'first');
		await nextTurn();
		expect(effects).toBe(TENANT + 1);
		gate.resolve(); await Promise.all(pending); await bob;
		await expect(run(alice, 'after')).resolves.toBe(TENANT + 2);
	});

	it('protects a global reserve for tenants below one hundred entries', async () => {
		_setTenantResolver(user => user.tenant);
		const { run } = counted();
		for (let tenant = 0; tenant < 9; tenant++) await fill(run, TENANT, { tenantId: 'big' + tenant });
		const fresh = { user: { id: 'member' }, tenantId: 'fresh' };
		for (let i = 0; i < 100; i++) await expect(run(fresh, String(i))).resolves.toBe(1);
		// At its reserve share the tenant replaces its own oldest result.
		await expect(run(fresh, 'next')).resolves.toBe(1);
		await expect(run(fresh, '0')).resolves.toBe(2);
		await expect(run(fresh, '99')).resolves.toBe(1);
		await expect(run({ user: { id: 'member' }, tenantId: 'other' }, 'new')).resolves.toBe(1);
		await expect(run({ user: { id: 'member' }, tenantId: 'big0' }, 'new')).rejects.toMatchObject(capacityError);
		await expect(run({ user: { id: 'filler0' }, tenantId: 'big0' }, 'new')).resolves.toBe(1);
	});

	it('refuses a newcomer only when every slot is held by other callers', async () => {
		_setTenantResolver(user => user.tenant);
		const { effects, run } = counted();
		for (let tenant = 0; tenant < 9; tenant++) await fill(run, TENANT, { tenantId: 'big' + tenant });
		for (let tenant = 0; tenant < 10; tenant++) {
			for (let i = 0; i < 100; i++) await run({ user: { id: 'small' }, tenantId: 'small' + tenant }, String(i));
		}
		await expect(run({ user: { id: 'late' }, tenantId: 'late' }, 'first')).rejects.toMatchObject(capacityError);
		expect(effects.has('late:late:first')).toBe(false);
		await expect(run({ user: { id: 'filler0' }, tenantId: 'big0' }, 'new')).resolves.toBe(1);
		await expect(run({ user: { id: 'small' }, tenantId: 'small9' }, '99')).resolves.toBe(1);
	});

	it('gives calls without a tenant the whole store', async () => {
		const { run } = counted();
		await fill(run, GLOBAL);
		await expect(run({ user: { id: 'newcomer' } }, 'first')).rejects.toMatchObject(capacityError);
		await expect(run({ user: { id: 'filler0' } }, 'next')).resolves.toBe(1);
	});

	it('caps calls a tenant resolver leaves unscoped as one tenant-sized bucket', async () => {
		_setTenantResolver(user => user.tenant ?? null);
		const run = live.idempotent({ keyFrom: (ctx, key) => key }, async (ctx, key) => key);
		let anonymous;
		for (let i = 0; i < TENANT; i++) {
			if (i % 9 === 0) anonymous = { user: null, ws: {} };
			await run(anonymous, String(i));
		}
		await expect(run({ user: null, ws: {} }, 'overflow')).rejects.toMatchObject(capacityError);
		await expect(run({ user: { id: 'member' }, tenantId: 'paid' }, 'first')).resolves.toBe('first');
	});

	it('keeps calls without a tenant out of the reserve while a tenant holds slots', async () => {
		const { run } = counted();
		const small = { user: { id: 'member' }, tenantId: 'small' };
		await run(small, 'first');
		await fill(run, GLOBAL - TENANT - 1);
		await expect(run({ user: { id: 'newcomer' } }, 'first')).rejects.toMatchObject(capacityError);
		for (let i = 0; i < 99; i++) await expect(run(small, String(i))).resolves.toBe(1);
		await expect(run({ user: { id: 'member' }, tenantId: 'fresh' }, 'new')).resolves.toBe(1);
	});

	for (const ttl of [0, 60]) {
		it(`reserves capacity for concurrent pending handlers with TTL ${ttl}`, async () => {
			const gate = deferred(); gates.push(gate);
			let effects = 0;
			const run = live.idempotent({ ttl, keyFrom: (ctx, key) => key }, async () => { effects++; await gate.promise; return effects; });
			const caller = i => ({ user: { id: 'u' + Math.floor(i / 99) } });
			const pending = Array.from({ length: GLOBAL }, (_, i) => run(caller(i), String(i)));
			await nextTurn();
			const duplicate = ttl > 0 ? run(caller(0), '0') : null;
			const overflow = run({ user: { id: 'newcomer' } }, 'overflow').catch(error => error);
			await nextTurn();
			expect(effects).toBe(GLOBAL);
			gate.resolve(); await Promise.all(pending);
			if (duplicate) expect(await duplicate).toBe(GLOBAL);
			expect(await overflow).toMatchObject(capacityError);
			if (ttl === 0) await expect(run({ user: { id: 'newcomer' } }, 'fresh')).resolves.toBe(GLOBAL + 1);
			else {
				await expect(run({ user: { id: 'newcomer' } }, 'fresh')).rejects.toMatchObject(capacityError);
				await expect(run(caller(0), 'fresh')).resolves.toBe(GLOBAL + 1);
			}
		});
	}

	it('releases an aborted reservation without dropping another accepted result', async () => {
		const gate = deferred(); gates.push(gate);
		const run = live.idempotent({ keyFrom: (ctx, key) => key }, async (ctx, key) => {
			if (key === 'abort') { await gate.promise; throw Error('handler failed'); }
			return key;
		});
		await fill(run, GLOBAL - 1);
		const pending = run({ user: { id: 'aborting' } }, 'abort').catch(error => error);
		await nextTurn();
		await expect(run({ user: { id: 'newcomer' } }, 'overflow')).rejects.toMatchObject(capacityError);
		gate.resolve(); expect((await pending).message).toBe('handler failed');
		await expect(run({ user: { id: 'newcomer' } }, 'fresh')).resolves.toBe('fresh');
		await expect(run({ user: { id: 'filler0' } }, 'f0')).resolves.toBe('f0');
	});

	it('reclaims expired results under pressure before the periodic sweep is due', async () => {
		const run = live.idempotent({ ttl: 1, keyFrom: (ctx, key) => key }, async (ctx, key) => key);
		await fill(run, GLOBAL);
		clock += 1001;
		await expect(run({ user: { id: 'newcomer' } }, 'fresh')).resolves.toBe('fresh');
	});

	it('releases erased cached results for new admission', async () => {
		const run = live.idempotent({ keyFrom: (ctx, key) => ctx.user.id + ':' + key }, async (ctx, key) => key);
		await run({ user: { id: 'alice' } }, 'erase');
		await fill(run, GLOBAL - 1);
		await expect(run({ user: { id: 'newcomer' } }, 'overflow')).rejects.toMatchObject(capacityError);
		await live.forget('alice');
		await expect(run({ user: { id: 'newcomer' } }, 'fresh')).resolves.toBe('fresh');
	});

	it('counts replaced and refused admissions without labelling callers', async () => {
		const events = [];
		state.metricsInstruments = /** @type {any} */ ({ idempotencyCapacity: { inc: labels => events.push(labels) } });
		const gate = deferred(); gates.push(gate);
		const run = live.idempotent({ keyFrom: (ctx, key) => key }, async (ctx, key) => { if (key.startsWith('hold')) await gate.promise; return key; });
		const alice = { user: { id: 'alice' } };
		for (let i = 0; i <= TENANT; i++) await run(alice, String(i));
		const held = Array.from({ length: TENANT }, (_, i) => run({ user: { id: 'bob' } }, 'hold' + i));
		await nextTurn();
		await expect(run({ user: { id: 'bob' } }, 'hold-over')).rejects.toMatchObject(capacityError);
		gate.resolve(); await Promise.all(held);
		expect(events).toEqual([{ outcome: 'replaced' }, { outcome: 'rejected' }]);
	});
});
