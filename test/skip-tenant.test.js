import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { live, _resetAlarms } from '../src/server.js';
import { _bindAlarmCtx } from '../src/server/alarm.js';
import { _buildCtx, _getCtxHelpers } from '../src/server/ctx.js';
import { state, registry } from '../src/server/state.js';
import { mockPlatform } from './helpers/mock-platform.js';
import { createTestEnv } from '../src/testing.js';
import { _setTenantResolver, _resetTenantResolver } from '../src/server/tenant.js';

let env;
afterEach(() => { env?.cleanup(); env = null; _resetTenantResolver(); });

function setup() {
	_setTenantResolver((user) => user.tenant ?? null);
	env = createTestEnv();
	env.register('gate', { hit: live((ctx, key) => ctx.skip(key, 60_000)) });
}

describe('ctx.skip with tenancy', () => {
	it('keeps one tenant from gating another tenant that picked the same key', async () => {
		setup();
		const a = env.connect({ id: 'a', tenant: 'alpha' });
		const b = env.connect({ id: 'b', tenant: 'beta' });
		const key = 'move:' + Math.random();
		expect(await a.call('gate/hit', key)).toBe(false);
		expect(await b.call('gate/hit', key)).toBe(false);
		expect(await a.call('gate/hit', key)).toBe(true);
		expect(await b.call('gate/hit', key)).toBe(true);
	});

	it('keeps unscoped callers and tenants apart, including keys spelled like a tenant prefix', async () => {
		setup();
		const tenant = env.connect({ id: 't', tenant: 'alpha' });
		const unscoped = env.connect({ id: 'u' });
		const key = 'k' + Math.random();
		expect(await unscoped.call('gate/hit', '\0alpha\0' + key)).toBe(false);
		expect(await unscoped.call('gate/hit', 'alpha\0' + key)).toBe(false);
		expect(await tenant.call('gate/hit', key)).toBe(false);
		expect(await unscoped.call('gate/hit', key)).toBe(false);
		expect(await unscoped.call('gate/hit', key)).toBe(true);
	});

	it('still rejects a non-string key', async () => {
		setup();
		const a = env.connect({ id: 'a', tenant: 'alpha' });
		await expect(a.call('gate/hit', 42)).rejects.toMatchObject({ code: 'INVALID_ARG' });
	});
});

describe('ctx.skip shared between RPC handlers and alarms', () => {
	let platform, savedPlatform;
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(10000);
		savedPlatform = state.cronPlatform;
		platform = mockPlatform();
		state.cronPlatform = platform;
	});
	afterEach(() => {
		_resetAlarms();
		_resetTenantResolver();
		state.cronPlatform = savedPlatform;
		registry.delete('rooms/skip-alarm');
		vi.useRealTimers();
	});

	async function alarmSkip(user, wireTopic, tenantId, key) {
		let gated;
		const onAlarm = ctx => { gated = ctx.skip(key, 60_000); };
		registry.set('rooms/skip-alarm', live.stream('room', () => ({}), { alarm: { onAlarm } }));
		const ctx = _buildCtx(user, null, platform, _getCtxHelpers(platform), null);
		_bindAlarmCtx(ctx, { wireTopic, onAlarm, path: 'rooms/skip-alarm', tenantId });
		await ctx.setAlarm(Date.now() + 10);
		await vi.advanceTimersByTimeAsync(20);
		return gated;
	}

	it('gates an alarm on a key an RPC handler used, without a tenant resolver', async () => {
		const key = 'tick:' + Math.random();
		const rpc = _buildCtx({ id: 'a' }, null, platform, _getCtxHelpers(platform), null);
		expect(rpc.skip(key, 60_000)).toBe(false);
		expect(await alarmSkip({ id: 'a' }, 'room', null, key)).toBe(true);
	});

	it('shares the gate within a tenant and within the unscoped scope', async () => {
		_setTenantResolver(user => user.tenant ?? null);
		const helpers = _getCtxHelpers(platform);
		const tenantKey = 'tick:' + Math.random();
		expect(_buildCtx({ id: 'a', tenant: 'alpha' }, null, platform, helpers, null).skip(tenantKey, 60_000)).toBe(false);
		expect(await alarmSkip({ id: 'a', tenant: 'alpha' }, '@t/alpha/room', 'alpha', tenantKey)).toBe(true);
		const unscopedKey = 'tick:' + Math.random();
		expect(_buildCtx({ id: 'u' }, null, platform, helpers, null).skip(unscopedKey, 60_000)).toBe(false);
		expect(await alarmSkip({ id: 'u' }, 'room', null, unscopedKey)).toBe(true);
	});
});
