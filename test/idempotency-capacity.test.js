import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { live, _resetForget, _resetIdempotencyStore, __register, __directCall, __registerCron, _clearCron, _tickCron, setCronPlatform } from '../src/server.js';
import { mockPlatform } from './helpers/mock-platform.js';
import { memoryAlarmStore } from './helpers/alarm-store.js';
import { configureAlarm, _resetAlarms } from '../src/server.js';
import { _pollAlarms } from '../src/server/alarm.js';
import { _cronIntrospect } from '../src/server/cron-engine.js';
import { registry } from '../src/server/state.js';
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

// Call an idempotent handler with a client envelope key, the key a caller owns.
function enveloped(handler) {
	return (ctx, key) => handler({ ...ctx, _idempotencyKey: key }, key);
}

// Fill `count` slots from callers that each stay below every reserve
// threshold (a hundredth of their share), so only the shared totals limit them.
async function fill(run, count, base = {}, per = base.tenantId ? 9 : 99) {
	for (let i = 0; i < count; i++) {
		await run({ ...base, user: { id: 'filler' + Math.floor(i / per) } }, 'f' + i);
	}
}

describe('idempotency capacity preserves accepted effects', () => {
	let env, clock, gates, savedErrorHandler, cronErrors;
	beforeEach(() => {
		savedErrorHandler = state.serverErrorHandler; cronErrors = [];
		state.serverErrorHandler = (path, error) => { cronErrors.push(error?.code); };
		_resetIdempotencyStore(); _resetForget();
		clock = 1000; gates = [];
		setRuntimeEnv({ clock: { now: () => clock, monotonic: () => clock, wallEpoch: () => clock } });
	});
	afterEach(() => {
		for (const gate of gates) gate.resolve();
		env?.cleanup(); env = null;
		state.metricsInstruments = null;
		_resetIdempotencyStore(); _resetForget(); _resetTenantResolver(); resetRuntimeEnv(); _clearCron();
		state.serverErrorHandler = savedErrorHandler;
	});

	// Run every registered cron job once and wait until each has settled.
	async function tick(settled) {
		const before = settled();
		await _tickCron();
		for (let i = 0; i < 100 && (settled() <= before || _cronIntrospect().running > 0); i++) await nextTurn();
		expect(settled()).toBeGreaterThan(before);
		expect(_cronIntrospect().running).toBe(0);
	}

	function visitorPages(platform) {
		__register('pages/visit', live.idempotent({ keyFrom: (ctx, key) => key }, async (ctx, key) => key));
		return key => __directCall('pages/visit', [key], platform, { user: null });
	}

	function counted() {
		const effects = new Map();
		const run = enveloped(live.idempotent({}, async (ctx, key) => {
			const id = (ctx.tenantId ?? '') + ':' + (ctx.user?.id ?? '') + ':' + key;
			const count = (effects.get(id) || 0) + 1; effects.set(id, count);
			return count;
		}));
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
		for (let i = 0; i < GLOBAL; i++) await hostile.call('work/run', String(i)).catch(() => {});
		expect(await honest.call('work/run', 'paid')).toBe(1);
		expect(effects.get('honest:paid')).toBe(1);
		expect(await honest.call('work/run', 'fresh')).toBe(1);
		// A keyFrom key may be shared, so the hostile caller keeps its results and is refused.
		expect(await hostile.call('work/run', '0')).toBe(1);
		await expect(hostile.call('work/run', 'new')).rejects.toMatchObject(capacityError);
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

	it.each([true, false])('refuses a new key and keeps a cached result when other callers fill the store (identified: %s)', async identified => {
		env = createTestEnv();
		const effects = new Map();
		env.register('work', { run: live.idempotent({ keyFrom: (ctx, key) => key }, async (ctx, key) => {
			const count = (effects.get(key) || 0) + 1; effects.set(key, count);
			return count;
		}) });
		const bob = env.connect(identified ? { id: 'bob' } : {});
		expect(await bob.call('work/run', 'paid')).toBe(1);
		let other;
		for (let i = 0; i < GLOBAL - 1; i++) {
			if (i % 99 === 0) other = env.connect(identified ? { id: 'other' + i } : {});
			await other.call('work/run', 'other' + i);
		}
		await expect(bob.call('work/run', 'fresh')).rejects.toMatchObject(capacityError);
		expect(await bob.call('work/run', 'paid')).toBe(1);
		expect(effects.get('paid')).toBe(1);
		expect(effects.has('fresh')).toBe(false);
	});

	it('refuses a new key and keeps a cached result when the tenant is full', async () => {
		_setTenantResolver(user => user.tenant);
		const { effects, run } = counted();
		const bob = { user: { id: 'bob' }, tenantId: 'acme' };
		expect(await run(bob, 'paid')).toBe(1);
		await fill(run, TENANT - 1, { tenantId: 'acme' });
		await expect(run(bob, 'fresh')).rejects.toMatchObject(capacityError);
		expect(await run(bob, 'paid')).toBe(1);
		expect(effects.get('acme:bob:paid')).toBe(1);
		await expect(run({ user: { id: 'bob' }, tenantId: 'other' }, 'fresh')).resolves.toBe(1);
	});

	it('never gives up a keyFrom result that other callers may share', async () => {
		const { run } = counted();
		let billed = 0;
		const billing = live.idempotent({ keyFrom: () => 'billing-day1' }, async () => ++billed);
		const alice = { user: { id: 'alice' } };
		expect(await billing(alice)).toBe(1);
		for (let i = 0; i < TENANT; i++) await run(alice, String(i));
		expect(await billing({ user: { id: 'bob' } })).toBe(1);
		expect(billed).toBe(1);
		// Alice gave up her own oldest envelope result instead.
		expect(await run(alice, '0')).toBe(2);
	});

	it('refuses a caller at its share whose results all come from keyFrom', async () => {
		let effects = 0;
		const run = live.idempotent({ keyFrom: (ctx, key) => key }, async () => ++effects);
		const alice = { user: { id: 'alice' } };
		for (let i = 0; i < TENANT; i++) await run(alice, 'k' + i);
		await expect(run(alice, 'over')).rejects.toMatchObject(capacityError);
		expect(await run({ user: { id: 'bob' } }, 'k0')).toBe(1);
		expect(effects).toBe(TENANT);
	});

	it('keeps scheduled jobs admitted while visitors fill the server-side bucket', async () => {
		const platform = mockPlatform();
		setCronPlatform(platform);
		const visit = visitorPages(platform);
		let invoked = 0, nightly = 0;
		const job = live.idempotent({ keyFrom: () => 'nightly-day1' }, async () => { nightly++; });
		// Count every run of the job, so a second run proves the cached answer.
		__registerCron('jobs/nightly', live.cron('* * * * *', 'nightly', async ctx => { invoked++; await job(ctx); }));
		for (let i = 0; i < TENANT; i++) await visit('v' + i);
		await expect(visit('over')).rejects.toMatchObject(capacityError);
		await tick(() => invoked + cronErrors.length);
		await tick(() => invoked + cronErrors.length);
		expect(cronErrors).toEqual([]);
		expect(invoked).toBe(2);
		expect(nightly).toBe(1);
	});

	it('bounds cron jobs by their own pool, not a tenant share', async () => {
		_setTenantResolver(user => user?.tenant ?? null);
		setCronPlatform(mockPlatform());
		let minute = 0, swept = 0;
		__registerCron('jobs/sweep', live.cron('* * * * *', 'sweep', live.idempotent({ keyFrom: () => 'sweep-' + minute }, async () => { swept++; })));
		const settled = () => swept + cronErrors.length;
		for (minute = 0; minute < 1000; minute++) await tick(settled);
		expect(cronErrors).toEqual([]);
		expect(swept).toBe(1000);
		await tick(settled);
		expect(cronErrors).toEqual(['IDEMPOTENCY_CAPACITY']);
		// Callers are unaffected by a full cron pool.
		await expect(enveloped(live.idempotent({}, async () => 'ok'))({ user: { id: 'alice' } }, 'k')).resolves.toBe('ok');
	});

	it('keeps cron marked through a lock deadline and a spread fan-out', async () => {
		const platform = mockPlatform();
		setCronPlatform(platform);
		const visit = visitorPages(platform);
		for (let i = 0; i < TENANT; i++) await visit('v' + i);
		let locked = 0, fanned = 0, settledRuns = 0;
		__registerCron('jobs/locked', live.cron('* * * * *', 'locked', live.lock({ key: 'locked', maxExecutionMs: 60000 },
			live.idempotent({ keyFrom: () => 'locked-day1' }, async () => { locked++; settledRuns++; }))));
		const fanOut = live.idempotent({ keyFrom: ctx => 'fan-' + ctx.tenantId }, async () => { fanned++; });
		__registerCron('jobs/fan', live.cron('* * * * *', 'fan', async ctx => {
			for (const tenantId of ['acme', 'beta']) await fanOut({ ...ctx, tenantId });
			settledRuns++;
		}));
		await _tickCron();
		await vi.waitFor(() => { expect(settledRuns + cronErrors.length).toBe(2); expect(_cronIntrospect().running).toBe(0); });
		expect(cronErrors).toEqual([]);
		expect(locked).toBe(1);
		expect(fanned).toBe(2);
	});

	it('gives an anonymous connection its own envelope results to replace', async () => {
		const { effects, run } = counted();
		const noisy = { user: null, ws: {} }, quiet = { user: null, ws: {} };
		expect(await run(quiet, 'quiet')).toBe(1);
		for (let i = 0; i < TENANT; i++) await run(noisy, 'n' + i);
		expect(await run(noisy, 'n-last')).toBe(1);
		expect(await run(noisy, 'n0')).toBe(2);
		expect(await run(quiet, 'quiet')).toBe(1);
		expect(effects.get('::quiet')).toBe(1);
	});

	it('names no wait while a caller at its share still has calls running', async () => {
		const gate = deferred(); gates.push(gate);
		const run = live.idempotent({ keyFrom: (ctx, key) => key }, async (ctx, key) => { if (key === 'slow') await gate.promise; return key; });
		const alice = { user: { id: 'alice' } };
		for (let i = 1; i < TENANT; i++) await run(alice, 'k' + i);
		const slow = run(alice, 'slow');
		await nextTurn();
		const refusal = await run(alice, 'over').catch(error => error);
		expect(refusal).toMatchObject(capacityError);
		expect(refusal.retryAfter).toBeUndefined();
		expect(refusal.message).toMatch(/still running/);
		gate.resolve(); await slow;
	});

	it('names the wait until the oldest result expires when a caller cannot give one up', async () => {
		let effects = 0;
		const run = live.idempotent({ ttl: 60, keyFrom: (ctx, key) => ctx.user.id + ':' + key }, async () => ++effects);
		const alice = { user: { id: 'alice' } };
		await run(alice, 'first');
		clock += 5000;
		for (let i = 1; i < TENANT; i++) await run(alice, 'k' + i);
		const refusal = await run(alice, 'over').catch(error => error);
		expect(refusal).toMatchObject({ code: 'IDEMPOTENCY_CAPACITY', retryAfter: 55000 });
		expect(refusal.message).not.toMatch(/store is full/);
		clock += 55000;
		await expect(run(alice, 'over')).resolves.toBe(TENANT + 1);
	});

	it('never replaces a result held for calls with neither an identity nor a connection', async () => {
		const { effects, run } = counted();
		const scheduled = { user: null };
		expect(await run(scheduled, 'nightly')).toBe(1);
		for (let i = 1; i < TENANT; i++) await run({ user: null }, 'job' + i);
		await expect(run({ user: null }, 'overflow')).rejects.toMatchObject(capacityError);
		expect(await run(scheduled, 'nightly')).toBe(1);
		expect(effects.get('::nightly')).toBe(1);
		await expect(run({ user: null, ws: {} }, 'anonymous')).resolves.toBe(1);
		await expect(run({ user: { id: 'alice' } }, 'signed-in')).resolves.toBe(1);
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
		for (let i = 0; i < GLOBAL; i++) await noisy.call('work/run', 'noisy' + i).catch(() => {});
		expect(await quiet.call('work/run', 'quiet')).toBe(1);
		expect(await quiet.call('work/run', 'quiet-fresh')).toBe(1);
		expect(await noisy.call('work/run', 'noisy0')).toBe(1);
		await expect(noisy.call('work/run', 'noisy-new')).rejects.toMatchObject(capacityError);
	});

	it('refuses a caller whose share is all running handlers, before its handler runs', async () => {
		const gate = deferred(); gates.push(gate);
		let effects = 0;
		const run = enveloped(live.idempotent({}, async () => { effects++; await gate.promise; return effects; }));
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
		await expect(run({ user: { id: 'filler0' }, tenantId: 'big0' }, 'new')).rejects.toMatchObject(capacityError);
		await expect(run({ user: { id: 'filler0' }, tenantId: 'big0' }, 'f0')).resolves.toBe(1);
	});

	it('refuses new keys and keeps every cached result when every slot is held', async () => {
		_setTenantResolver(user => user.tenant);
		const { effects, run } = counted();
		for (let tenant = 0; tenant < 9; tenant++) await fill(run, TENANT, { tenantId: 'big' + tenant });
		for (let tenant = 0; tenant < 10; tenant++) {
			for (let i = 0; i < 100; i++) await run({ user: { id: 'small' }, tenantId: 'small' + tenant }, String(i));
		}
		await expect(run({ user: { id: 'late' }, tenantId: 'late' }, 'first')).rejects.toMatchObject(capacityError);
		expect(effects.has('late:late:first')).toBe(false);
		await expect(run({ user: { id: 'filler0' }, tenantId: 'big0' }, 'new')).rejects.toMatchObject(capacityError);
		await expect(run({ user: { id: 'filler0' }, tenantId: 'big0' }, 'f0')).resolves.toBe(1);
		await expect(run({ user: { id: 'small' }, tenantId: 'small9' }, '99')).resolves.toBe(1);
	});

	it('gives calls without a tenant the whole store', async () => {
		const { run } = counted();
		await fill(run, GLOBAL);
		await expect(run({ user: { id: 'newcomer' } }, 'first')).rejects.toMatchObject(capacityError);
		await expect(run({ user: { id: 'filler0' } }, 'next')).rejects.toMatchObject(capacityError);
		await expect(run({ user: { id: 'filler0' } }, 'f0')).resolves.toBe(1);
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
				await expect(run(caller(0), 'fresh')).rejects.toMatchObject(capacityError);
				await expect(run(caller(0), '0')).resolves.toBe(GLOBAL);
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
		const run = enveloped(live.idempotent({}, async (ctx, key) => { if (key.startsWith('hold')) await gate.promise; return key; }));
		const alice = { user: { id: 'alice' } };
		for (let i = 0; i <= TENANT; i++) await run(alice, String(i));
		const held = Array.from({ length: TENANT }, (_, i) => run({ user: { id: 'bob' } }, 'hold' + i));
		await nextTurn();
		await expect(run({ user: { id: 'bob' } }, 'hold-over')).rejects.toMatchObject(capacityError);
		gate.resolve(); await Promise.all(held);
		expect(events).toEqual([{ outcome: 'replaced' }, { outcome: 'rejected' }]);
	});
});

describe('idempotency capacity for alarms', () => {
	let platform, savedPlatform;
	beforeEach(() => {
		vi.useFakeTimers(); vi.setSystemTime(10000);
		_resetIdempotencyStore();
		savedPlatform = state.cronPlatform;
		platform = mockPlatform();
		state.cronPlatform = platform;
		_setTenantResolver(user => user?.tenant ?? null);
	});
	afterEach(() => {
		_resetAlarms(); configureAlarm(null); _resetTenantResolver(); _resetIdempotencyStore();
		state.cronPlatform = savedPlatform;
		registry.delete('rooms/closing');
		vi.useRealTimers();
	});

	function closingRoom(effects) {
		const onAlarm = live.idempotent({ keyFrom: ctx => ctx.alarm.idempotencyKey }, async ctx => {
			effects.set(ctx.tenantId, (effects.get(ctx.tenantId) || 0) + 1);
		});
		registry.set('rooms/closing', live.stream('room', () => ({}), { alarm: { onAlarm } }));
		const store = memoryAlarmStore();
		configureAlarm({ store });
		return store;
	}

	it('charges an alarm to its own bucket, apart from server-side visitor calls', async () => {
		const effects = new Map();
		const store = closingRoom(effects);
		__register('pages/visit', live.idempotent({ keyFrom: (ctx, key) => key }, async (ctx, key) => key));
		for (let i = 0; i < TENANT / 10; i++) await __directCall('pages/visit', ['v' + i], platform, { user: null });
		await expect(__directCall('pages/visit', ['over'], platform, { user: null })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CAPACITY' });
		store.seed('room', Date.now() - 1, { path: 'rooms/closing', tenantId: null });
		await _pollAlarms();
		expect(effects.get(null)).toBe(1);
	});

	const fillWith = live.idempotent({ keyFrom: (ctx, key) => key }, async () => null);

	it('runs an alarm while the store and its tenant are full', async () => {
		const effects = new Map();
		const store = closingRoom(effects);
		// Nine full tenants and ten at the reserve threshold fill the store.
		for (const tenantId of ['acme', 'b1', 'b2', 'b3', 'b4', 'b5', 'b6', 'b7', 'b8']) {
			for (let i = 0; i < TENANT; i++) await fillWith({ user: { id: 'filler' + Math.floor(i / 9) }, tenantId }, 'f' + i);
		}
		for (let t = 0; t < 10; t++) {
			for (let i = 0; i < TENANT / 10; i++) await fillWith({ user: { id: 'small' + Math.floor(i / 9) }, tenantId: 'small' + t }, 'f' + i);
		}
		await expect(fillWith({ user: { id: 'late' }, tenantId: 'late' }, 'x')).rejects.toMatchObject(capacityError);
		await expect(fillWith({ user: { id: 'late' }, tenantId: 'acme' }, 'x')).rejects.toMatchObject(capacityError);
		store.seed('@t/acme/room', Date.now() - 1, { path: 'rooms/closing', tenantId: 'acme' });
		await _pollAlarms();
		expect(effects.get('acme')).toBe(1);
	});

	it('runs an alarm while anonymous connections fill the store without tenants', async () => {
		_resetTenantResolver();
		const effects = new Map();
		const store = closingRoom(effects);
		let ws;
		for (let i = 0; i < GLOBAL; i++) {
			if (i % 99 === 0) ws = {};
			await fillWith({ user: null, ws }, 'f' + i);
		}
		await expect(fillWith({ user: null, ws: {} }, 'x')).rejects.toMatchObject(capacityError);
		store.seed('room', Date.now() - 1, { path: 'rooms/closing', tenantId: null });
		await _pollAlarms();
		expect(effects.get(null)).toBe(1);
	});

	it('divides the alarm pool between tenants', async () => {
		const effects = new Map();
		const store = closingRoom(effects);
		for (let i = 0; i <= TENANT / 10; i++) store.seed('@t/acme/room' + i, Date.now() - 1, { path: 'rooms/closing', tenantId: 'acme' });
		store.seed('@t/beta/room', Date.now() - 1, { path: 'rooms/closing', tenantId: 'beta' });
		await _pollAlarms();
		expect(effects.get('acme')).toBe(TENANT / 10);
		expect(effects.get('beta')).toBe(1);
	});
});
