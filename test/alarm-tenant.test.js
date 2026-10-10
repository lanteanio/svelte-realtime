import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { live, configureAlarm, _resetAlarms } from '../src/server.js';
import { _bindAlarmCtx, _pollAlarms } from '../src/server/alarm.js';
import { _buildCtx, _getCtxHelpers } from '../src/server/ctx.js';
import { _setTenantResolver, _resetTenantResolver } from '../src/server/tenant.js';
import { state, registry } from '../src/server/state.js';
import { mockPlatform } from './helpers/mock-platform.js';

function memoryStore() {
	const rows = new Map();
	return {
	rows,
	set(topic, at, meta) { rows.set(topic, { topic, at, meta }); },
	delete(topic) { return rows.delete(topic); },
	due(now) { return [...rows.values()].filter(row => row.at <= now); }
	};
}

describe('alarm callback tenant scope', () => {
	let platform, savedPlatform;
	beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(10000);
	savedPlatform = state.cronPlatform;
	platform = mockPlatform();
	state.cronPlatform = platform;
	_setTenantResolver(user => user === null ? 'fallback' : user.tenant);
	});
	afterEach(() => {
	_resetAlarms();
	configureAlarm(null);
	_resetTenantResolver();
	state.cronPlatform = savedPlatform;
	registry.delete('rooms/tenant-alarm');
	vi.useRealTimers();
	});

	for (const recovered of [false, true]) {
	it(`restores two tenant scopes and the unscoped room during ${recovered ? 'recovery' : 'precise firing'}`, async () => {
		const store = memoryStore();
		const seen = [];
		const onAlarm = async ctx => {
		seen.push({ tenantId: ctx.tenantId, recovered: ctx.alarm.recovered });
		ctx.publish('alarm', {});
		ctx.batch([{ topic: 'side', event: 'changed', data: {} }]);
		await ctx.setAlarm(Date.now() + 60000);
		};
		registry.set('rooms/tenant-alarm', live.stream('room', () => ({}), { alarm: { onAlarm } }));
		configureAlarm({ store });
		for (const tenantId of ['acme', 'beta', null]) {
		const topic = tenantId === null ? 'room' : `@t/${tenantId}/room`;
		if (recovered) {
			store.set(topic, Date.now() - 1, { path: 'rooms/tenant-alarm', tenantId });
		} else {
			const ctx = _buildCtx({ tenant: tenantId }, null, platform, _getCtxHelpers(platform), null);
			expect(ctx.tenantId).toBe(tenantId);
			_bindAlarmCtx(ctx, { wireTopic: topic, onAlarm, path: 'rooms/tenant-alarm', tenantId });
			await ctx.setAlarm(Date.now() + 10);
		}
		}
		if (recovered) await _pollAlarms();
		else await vi.advanceTimersByTimeAsync(20);
		expect(seen).toEqual(['acme', 'beta', null].map(tenantId => ({ tenantId, recovered })));
		expect(platform.published.map(row => row.topic)).toEqual([
		'@t/acme/room', '@t/acme/side', '@t/beta/room', '@t/beta/side', 'room', 'side'
		]);
		expect([...store.rows.values()].map(row => row.meta.tenantId)).toEqual(['acme', 'beta', null]);
	});
	}

	it('retains invalid or mismatched persisted tenant scopes without invoking handlers', async () => {
	const store = memoryStore();
	const onAlarm = vi.fn();
	registry.set('rooms/tenant-alarm', live.stream('room', () => ({}), { alarm: { onAlarm } }));
	store.set('@t/acme/room', Date.now() - 1, { path: 'rooms/tenant-alarm', tenantId: 'beta' });
	store.set('@t/bad/room', Date.now() - 1, { path: 'rooms/tenant-alarm', tenantId: 'bad/id' });
	store.set('@t/missing/room', Date.now() - 1, { path: 'rooms/tenant-alarm' });
	configureAlarm({ store });
	await _pollAlarms();
	expect(onAlarm).not.toHaveBeenCalled();
	expect(store.rows.size).toBe(3);
	});

	it('keeps a scheduled tenant scope after the resolver is removed', async () => {
	const seen = [];
	const ctx = {};
	_bindAlarmCtx(ctx, { wireTopic: '@t/acme/room', tenantId: 'acme', onAlarm: ctx => {
		seen.push(ctx.tenantId);
		ctx.batch([{ topic: 'side', event: 'changed', data: {} }]);
	} });
	await ctx.setAlarm(Date.now() + 10);
	_resetTenantResolver();
	await vi.advanceTimersByTimeAsync(20);
	expect(seen).toEqual(['acme']);
	expect(platform.published[0].topic).toBe('@t/acme/side');
	});
});