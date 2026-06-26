// introspect() - the admin/observability snapshot of live dispatch state. These
// cover the aggregation (handler kinds, push sizes, topic subscriber sums) and
// the PII-free-by-default contract (no handler paths / topic names unless opted
// in). Counts are asserted as deltas so the shared global registries (other
// describes in this file register handlers too) cannot make them brittle.

import { describe, it, expect, beforeEach } from 'vitest';
import { live, __register, introspect, pushHooks, _resetPushRegistry, _clearCron } from '../src/server.js';
import { _topicWsCounts } from '../src/server/state.js';
import { mockWs } from './helpers/mock-ws.js';
import { mockPlatform } from './helpers/mock-platform.js';

describe('introspect()', () => {
	beforeEach(() => {
		_resetPushRegistry();
		_clearCron();
		_topicWsCounts.clear();
	});

	it('returns a PII-free counts snapshot with the documented shape', () => {
		const snap = introspect();
		expect(typeof snap.shuttingDown).toBe('boolean');
		expect(typeof snap.inFlight).toBe('number');
		expect(typeof snap.handlers.total).toBe('number');
		expect(snap.handlers.byKind).toMatchObject({
			rpc: expect.any(Number), stream: expect.any(Number), channel: expect.any(Number),
			upload: expect.any(Number), binary: expect.any(Number), lazy: expect.any(Number)
		});
		expect(snap.handlers.modifiers).toMatchObject({
			deprecated: expect.any(Number), rateLimited: expect.any(Number),
			idempotent: expect.any(Number), volatile: expect.any(Number)
		});
		expect(snap.topics).toMatchObject({ active: expect.any(Number), subscribers: expect.any(Number) });
		expect(snap.push).toMatchObject({ users: expect.any(Number), sessions: expect.any(Number) });
		expect(snap.cron).toMatchObject({ jobs: expect.any(Number), schedulerActive: expect.any(Boolean) });
		expect(snap.reactive).toMatchObject({ derived: expect.any(Number), effect: expect.any(Number), aggregate: expect.any(Number), watchedTopics: expect.any(Number) });
		expect(snap.capacity).toMatchObject({ rateLimitBuckets: expect.any(Number), throttles: expect.any(Number), debounces: expect.any(Number), presenceRefs: expect.any(Number), lazyQueue: expect.any(Number) });
		expect(typeof snap.metrics).toBe('boolean');
		expect(typeof snap.admission).toBe('boolean');
		// Transport key is always present (null when no adapter platform captured).
		expect('transport' in snap).toBe(true);
		// PII-free by default: no handler paths, no topic names.
		expect(snap.handlers.paths).toBeUndefined();
		expect(snap.topics.top).toBeUndefined();
	});

	it('counts newly registered handlers by base kind + modifier', () => {
		const before = introspect();
		__register('introspect-test/echo', live(async () => 'ok'));
		__register('introspect-test/feed', live.stream('introspect-feed', async () => []));
		__register('introspect-test/old', live.deprecate(live(async () => 'ok'), { since: '0.6' }));
		const after = introspect();
		expect(after.handlers.total).toBe(before.handlers.total + 3);
		expect(after.handlers.byKind.rpc).toBe(before.handlers.byKind.rpc + 2); // echo + the deprecated rpc
		expect(after.handlers.byKind.stream).toBe(before.handlers.byKind.stream + 1);
		expect(after.handlers.modifiers.deprecated).toBe(before.handlers.modifiers.deprecated + 1);
	});

	it('opt-in { handlers: true } adds the registered paths (code structure, not PII)', () => {
		__register('introspect-test/listed', live(async () => 'ok'));
		const snap = introspect({ handlers: true });
		expect(Array.isArray(snap.handlers.paths)).toBe(true);
		expect(snap.handlers.paths).toContain('introspect-test/listed');
	});

	it('reflects push registry sizes (userId + sessionId)', () => {
		const platform = mockPlatform();
		pushHooks.open(mockWs({ user_id: 'u-1', session_id: 's-1' }), { platform });
		pushHooks.open(mockWs({ session_id: 's-2' }), { platform }); // session-only connection
		const snap = introspect();
		expect(snap.push.users).toBe(1);
		expect(snap.push.sessions).toBe(2);
	});

	it('sums topic subscribers; names appear only when opted in', () => {
		_topicWsCounts.set('room:a', new Set([mockWs({ id: 'w1' }), mockWs({ id: 'w2' })]));
		_topicWsCounts.set('room:b', new Set([mockWs({ id: 'w3' })]));
		const snap = introspect();
		expect(snap.topics.active).toBe(2);
		expect(snap.topics.subscribers).toBe(3);
		expect(snap.topics.top).toBeUndefined(); // names off by default
		const detailed = introspect({ topics: true });
		expect(detailed.topics.top[0]).toEqual({ topic: 'room:a', subscribers: 2 }); // sorted by count
		expect(detailed.topics.top).toHaveLength(2);
	});

	it('reflects the graceful-shutdown gate', async () => {
		expect(introspect().shuttingDown).toBe(false);
	});

	it('composes the adapter transport snapshot under `transport` when the platform provides it', async () => {
		const { state } = await import('../src/server/state.js');
		const saved = state.cronPlatform;
		const fakeTransport = {
			connections: 7, closedWsAborts: 0, protection: 'normal', maxPayloadLength: 1048576,
			pressure: { active: false, reason: 'NONE', value: 0, subscriberRatio: 0, publishRate: 0, memoryMB: 0 },
			assertions: {}
		};
		state.cronPlatform = { introspect: () => fakeTransport };
		try {
			expect(introspect().transport).toEqual(fakeTransport);
		} finally {
			state.cronPlatform = saved;
		}
	});

	it('reports transport: null when no adapter platform is captured', async () => {
		const { state } = await import('../src/server/state.js');
		const saved = state.cronPlatform;
		state.cronPlatform = null;
		try {
			expect(introspect().transport).toBeNull();
		} finally {
			state.cronPlatform = saved;
		}
	});

	it('keeps transport null when the platform introspect throws (never breaks the snapshot)', async () => {
		const { state } = await import('../src/server/state.js');
		const saved = state.cronPlatform;
		state.cronPlatform = { introspect: () => { throw new Error('boom'); } };
		try {
			const snap = introspect();
			expect(snap.transport).toBeNull();
			expect(typeof snap.handlers.total).toBe('number'); // rest of the snapshot intact
		} finally {
			state.cronPlatform = saved;
		}
	});
});
