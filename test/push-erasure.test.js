import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { live, pushHooks, _resetForget, _resetPushRegistry } from '../src/server.js';
import { _pushRegistry, _pushSessionRegistry, _wsToPushUserId, _wsToPushSessionId, _purgePushUser } from '../src/server/push.js';
import { _setTenantResolver, _resetTenantResolver } from '../src/server/tenant.js';
import { state } from '../src/server/state.js';

function reset() { _resetForget(); _resetPushRegistry(); _resetTenantResolver(); }
beforeEach(reset);
afterEach(reset);

function open(userId, sessionId, tenant) {
	const data = { userId, sessionId, tenant };
	const ws = { getUserData: vi.fn(() => data) };
	pushHooks.open(ws, { platform: {} });
	return { ws, data };
}

describe('push erasure uses registration identity', () => {
	it.each(['direct', 'composed'])('keeps other tenant routes when identity reads fail (%s)', async mode => {
		let broken = false;
		_setTenantResolver(user => { if (broken) throw new Error('unavailable'); return user.tenant; });
		const olderA = open('same', 'a-old', 'a');
		const currentA = open('same', 'a-new', 'a');
		const currentB = open('same', 'b', 'b');
		const other = open('other', 'other', 'a');
		broken = true;
		for (const { ws } of [olderA, currentA, currentB, other]) ws.getUserData.mockImplementation(() => { throw new Error('closed'); });
		const removed = mode === 'direct' ? _purgePushUser('a', 'same') : (await live.forget('same', { tenantId: 'a' })).surfaces.push;
		expect(removed).toBe(2);
		expect(_pushRegistry.get('same').ws).toBe(currentB.ws);
		expect(_pushRegistry.get('other').ws).toBe(other.ws);
		expect([..._pushSessionRegistry.keys()].sort()).toEqual(['b', 'other']);
		expect(_wsToPushSessionId.has(olderA.ws)).toBe(false);
		expect(_wsToPushSessionId.has(currentA.ws)).toBe(false);
		expect(_wsToPushSessionId.get(currentB.ws)).toBe('b');
		expect(_purgePushUser('b', 'same')).toBe(2);
		expect(_pushRegistry.has('same')).toBe(false);
		expect(_pushSessionRegistry.has('b')).toBe(false);
	});

	it('keeps captured scope when user data and the tenant resolver change', () => {
		_setTenantResolver(user => user.tenant);
		const member = open('same', 'session', 'b');
		member.data.tenant = 'a';
		_setTenantResolver(() => 'a');
		expect(_purgePushUser('a', 'same')).toBe(0);
		expect(_pushRegistry.get('same').ws).toBe(member.ws);
		_resetTenantResolver();
		expect(_purgePushUser(null, 'same')).toBe(0);
		expect(_purgePushUser('b', 'same')).toBe(2);
	});

	it('matches the null tenant exactly even without a resolver', () => {
		const member = open('same', 'session', null);
		expect(_purgePushUser('a', 'same')).toBe(0);
		expect(_pushRegistry.get('same').ws).toBe(member.ws);
		_setTenantResolver(() => 'a');
		expect(_purgePushUser('a', 'same')).toBe(0);
		expect(_pushSessionRegistry.get('session').ws).toBe(member.ws);
		expect(_purgePushUser(null, 'same')).toBe(2);
	});

	it('preserves a session replaced by another tenant', () => {
		_setTenantResolver(user => user.tenant);
		open('same', 'shared-session', 'a');
		const otherTenant = open('same', 'shared-session', 'b');
		open('same', 'own-session', 'a');
		expect(_purgePushUser('a', 'same')).toBe(2);
		expect(_pushRegistry.has('same')).toBe(false);
		expect([..._pushSessionRegistry.keys()]).toEqual(['shared-session']);
		expect(_pushSessionRegistry.get('shared-session').ws).toBe(otherTenant.ws);
		expect(_purgePushUser('b', 'same')).toBe(1);
	});

	it('attributes a session even when the user registry is full', () => {
		_setTenantResolver(user => user.tenant);
		const limit = state.maxPushRegistry;
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			state.maxPushRegistry = 1;
			open('retained', null, 'a');
			const member = open('same', 'session', 'a');
			expect(_pushRegistry.has('same')).toBe(false);
			expect(_pushSessionRegistry.get('session').ws).toBe(member.ws);
			expect(_purgePushUser('a', 'same')).toBe(1);
			expect(_pushRegistry.has('retained')).toBe(true);
			expect(_pushSessionRegistry.has('session')).toBe(false);
		} finally {
			state.maxPushRegistry = limit;
			warn.mockRestore();
		}
	});

	it('keeps close bookkeeping for a socket registered again in another tenant', () => {
		_setTenantResolver(user => user.tenant);
		const member = open('same', 'old-session', 'a');
		member.data.tenant = 'b';
		member.data.sessionId = 'new-session';
		pushHooks.open(member.ws, { platform: {} });
		expect(_purgePushUser('a', 'same')).toBe(1);
		expect(_pushRegistry.get('same').ws).toBe(member.ws);
		expect(_wsToPushUserId.get(member.ws)).toBe('same');
		expect(_wsToPushSessionId.get(member.ws)).toBe('new-session');
		pushHooks.close(member.ws);
		expect(_pushRegistry.has('same')).toBe(false);
		expect(_pushSessionRegistry.size).toBe(0);
	});

	it.each(['tenant', 'session', 'user-data'])('does not partially replace registrations when %s validation fails', mode => {
		_setTenantResolver(user => user.tenant);
		const original = open('same', 'session', 'a');
		const candidate = { getUserData: () => ({ userId: 'same', sessionId: mode === 'session' ? 'bad\n' : 'session', tenant: 'a' }) };
		if (mode === 'tenant') _setTenantResolver(() => 'bad tenant');
		if (mode === 'user-data') {
			live.configurePush({ identify: () => 'same', sessionIdentify: () => 'session' });
			candidate.getUserData = () => { throw new Error('unavailable'); };
		}
		expect(() => pushHooks.open(candidate, { platform: {} })).toThrow();
		expect(_pushRegistry.get('same').ws).toBe(original.ws);
		expect(_pushSessionRegistry.get('session').ws).toBe(original.ws);
		expect(_wsToPushUserId.has(candidate)).toBe(false);
		expect(_wsToPushSessionId.has(candidate)).toBe(false);
	});
});
