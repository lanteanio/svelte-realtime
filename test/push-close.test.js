import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pushHooks, _resetPushRegistry } from '../src/server.js';
import { _pushRegistry, _pushSessionRegistry, _wsToPushUserId, _wsToPushSessionId } from '../src/server/push.js';
import { getAssertionCounters, _resetAssertCounters } from '../src/shared/assert.js';

function reset() {
	_resetPushRegistry();
	_resetAssertCounters();
	vi.restoreAllMocks();
}
beforeEach(reset);
afterEach(reset);

function open(data) {
	const ws = { getUserData: () => data };
	pushHooks.open(ws, { platform: {} });
	return ws;
}

function close(ws, mode) {
	pushHooks.close(ws, mode === 'composed' ? { platform: {} } : undefined);
}

describe.each(['direct', 'composed'])('overlapping push sockets (%s close)', mode => {
	it.each([
		['user', { userId: 'same' }],
		['session', { sessionId: 'same-session' }],
		['both', { userId: 'same', sessionId: 'same-session' }]
	].flatMap(([identity, data]) => [
		[identity, 'newest first', data, [2, 1, 0]],
		[identity, 'older first', data, [1, 0, 2]]
	]))('closes three overlapping %s registrations %s without false assertions', (_identity, _order, data, order) => {
		const sockets = Array.from({ length: 3 }, () => open(data));
		let latestClosed = false;
		for (const index of order) {
			expect(() => close(sockets[index], mode)).not.toThrow();
			expect(() => close(sockets[index], mode)).not.toThrow();
			latestClosed ||= index === 2;
			const expected = latestClosed ? undefined : sockets[2];
			if (data.userId) expect(_pushRegistry.get(data.userId)?.ws).toBe(expected);
			if (data.sessionId) expect(_pushSessionRegistry.get(data.sessionId)?.ws).toBe(expected);
			expect(_wsToPushUserId.has(sockets[index])).toBe(false);
			expect(_wsToPushSessionId.has(sockets[index])).toBe(false);
		}
		expect(_pushRegistry.size).toBe(0);
		expect(_pushSessionRegistry.size).toBe(0);
		expect(getAssertionCounters().size).toBe(0);
	});

	it('preserves a replacement registered after the newest socket closed', () => {
		const data = { userId: 'same', sessionId: 'same-session' };
		const oldest = open(data), middle = open(data), newest = open(data);
		close(newest, mode);
		const replacement = open(data);
		close(oldest, mode);
		close(middle, mode);
		expect(_pushRegistry.get('same').ws).toBe(replacement);
		expect(_pushSessionRegistry.get('same-session').ws).toBe(replacement);
		close(replacement, mode);
		expect(_pushRegistry.size).toBe(0);
		expect(_pushSessionRegistry.size).toBe(0);
		expect(getAssertionCounters().size).toBe(0);
	});

	it.each(['user', 'session'])('still detects a missing route for the current %s owner', identity => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const ws = open(identity === 'user' ? { userId: 'same' } : { sessionId: 'same-session' });
		const registry = identity === 'user' ? _pushRegistry : _pushSessionRegistry;
		registry.clear();
		const category = identity === 'user' ? 'realtime/push-registry.entry-tracked' : 'realtime/push-session-registry.entry-tracked';
		expect(() => close(ws, mode)).toThrow(category);
		expect(getAssertionCounters().get(category)).toBe(1);
	});
});
