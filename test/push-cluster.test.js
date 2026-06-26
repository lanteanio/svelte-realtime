// Cluster routing for live.push / live.notify: the topic target prefers the
// platform.topicBroadcast coordinator (cross-instance fan-out), and the sessionId
// target prefers remoteRegistry.requestSession (cross-instance session routing).
// Both fall back to single-instance behavior when the cluster surface is absent.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { live, pushHooks, _resetPushRegistry } from '../src/server.js';
import { state } from '../src/server/state.js';

function mockWs(userData) {
	return { getUserData: () => userData };
}

describe('live.push / live.notify cluster routing', () => {
	let saved;
	beforeEach(() => { saved = state.cronPlatform; });
	afterEach(() => { state.cronPlatform = saved; _resetPushRegistry(); });

	describe('topic via platform.topicBroadcast', () => {
		it('prefers the cluster coordinator over single-instance requestTopic', async () => {
			let requestTopicCalled = false;
			state.cronPlatform = {
				requestTopic: async () => { requestTopicCalled = true; return []; },
				topicBroadcast: {
					onRequest() {},
					broadcast: async () => [
						{ ok: true, reply: 'cluster-A' },
						{ ok: false, error: 'request timed out' }
					]
				}
			};
			const out = await live.push({ topic: 'room' }, 'ping', { x: 1 });
			expect(out.replies).toEqual(['cluster-A']);
			expect(out.errors).toEqual([{ message: 'request timed out' }]);
			expect(out.count).toBe(2);
			expect(out.delivered).toBe(1);
			expect(requestTopicCalled).toBe(false); // the cluster path wins
		});

		it('wires onRequest once; the registered handler serves via platform.requestTopic', async () => {
			let registered = null;
			let served = null;
			state.cronPlatform = {
				requestTopic: async (t, e, d, o) => { served = { t, e, d, o }; return [{ ok: true, reply: 'local' }]; },
				topicBroadcast: {
					onRequest(fn) { registered = fn; },
					broadcast: async () => []
				}
			};
			await live.push({ topic: 'room' }, 'ping', { x: 1 });
			expect(typeof registered).toBe('function');
			// The coordinator calls this for the origin's own subscribers AND inbound
			// peer broadcasts - it must hit the single-instance requestTopic.
			const r = await registered('room', 'ping', { x: 1 }, { timeoutMs: 100 });
			expect(r).toEqual([{ ok: true, reply: 'local' }]);
			expect(served.t).toBe('room');
			expect(served.o).toEqual({ timeoutMs: 100 });
		});

		it('falls back to requestTopic when no topicBroadcast is present', async () => {
			state.cronPlatform = { requestTopic: async () => [{ ok: true, reply: 'single' }] };
			const out = await live.push({ topic: 'room' }, 'ping', {});
			expect(out.replies).toEqual(['single']);
			expect(out.count).toBe(1);
		});

		it('notify({ topic }) prefers the cluster coordinator', async () => {
			let broadcastCalled = false;
			let requestTopicCalled = false;
			state.cronPlatform = {
				requestTopic: () => { requestTopicCalled = true; return Promise.resolve([]); },
				topicBroadcast: {
					onRequest() {},
					broadcast: () => { broadcastCalled = true; return Promise.resolve([]); }
				}
			};
			await expect(live.notify({ topic: 'room' }, 'e', {})).resolves.toBeUndefined();
			expect(broadcastCalled).toBe(true);
			expect(requestTopicCalled).toBe(false);
		});
	});

	describe('sessionId via remoteRegistry.requestSession', () => {
		it('routes to requestSession when the remoteRegistry exposes it', async () => {
			let seen;
			live.configurePush({ remoteRegistry: {
				request: async () => { throw new Error('userId path must not run'); },
				requestSession: async (...args) => { seen = args; return { ok: true }; }
			} });
			const reply = await live.push({ sessionId: 'sess-1' }, 'confirm', { d: 1 }, { timeoutMs: 250 });
			expect(reply).toEqual({ ok: true });
			expect(seen[0]).toBe('sess-1');
			expect(seen[1]).toBe('confirm');
			expect(seen[2]).toEqual({ d: 1 });
			expect(seen[3]).toEqual({ timeoutMs: 250 });
		});

		it('falls back to the local session registry when requestSession is absent', async () => {
			const platform = { request: async (ws, event) => ({ local: true, event }) };
			pushHooks.open(mockWs({ session_id: 'sess-2' }), { platform });
			live.configurePush({ remoteRegistry: { request: async () => ({}) } }); // no requestSession
			const reply = await live.push({ sessionId: 'sess-2' }, 'confirm', {});
			expect(reply).toEqual({ local: true, event: 'confirm' });
		});

		it('falls back to the fresher local entry on a registry-offline race', async () => {
			const platform = { request: async () => ({ local: true }) };
			pushHooks.open(mockWs({ session_id: 'sess-3' }), { platform });
			live.configurePush({ remoteRegistry: {
				request: async () => ({}),
				requestSession: async () => { throw new Error('registry.requestSession: target session "sess-3" is offline'); }
			} });
			const reply = await live.push({ sessionId: 'sess-3' }, 'confirm', {});
			expect(reply).toEqual({ local: true });
		});

		it('propagates a non-offline requestSession error', async () => {
			live.configurePush({ remoteRegistry: {
				request: async () => ({}),
				requestSession: async () => { throw new Error('boom'); }
			} });
			await expect(live.push({ sessionId: 'sess-x' }, 'e', {})).rejects.toThrow('boom');
		});

		it('notify({ sessionId }) prefers requestSession (fire-and-forget)', async () => {
			let called = false;
			live.configurePush({ remoteRegistry: {
				request: async () => ({}),
				requestSession: async () => { called = true; return undefined; }
			} });
			await expect(live.notify({ sessionId: 'sess-n' }, 'e', {})).resolves.toBeUndefined();
			expect(called).toBe(true);
		});

		it('stays single-instance when no remoteRegistry is configured', async () => {
			const platform = { request: async () => ({ local: true }) };
			pushHooks.open(mockWs({ session_id: 'sess-solo' }), { platform });
			const reply = await live.push({ sessionId: 'sess-solo' }, 'e', {});
			expect(reply).toEqual({ local: true });
		});
	});
});
