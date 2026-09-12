// A socket may hold several rooms. Bookkeeping that is keyed by the socket
// alone leaks one room's state into another's: a failed subscribe to room B
// must not change how room A's ordinary leave behaves on the same socket, and a
// join's claim barrier must be gone once its batch consumed it.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { live, __register, handleRpc, unsubscribe, close } from '../src/server.js';
import { _presenceRef } from '../src/server/state.js';
import { _claimSlotCountForTests } from '../src/server/room-owner.js';
import { createTestEnv } from '../src/testing.js';
import { mockPlatform } from './helpers/mock-platform.js';
import { mockWs } from './helpers/mock-ws.js';
import { toArrayBuffer } from './helpers/encode.js';

const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const textEncoder = new TextEncoder();

describe('stream-subscribe rollback is scoped to its own topic', () => {
	it('a failed subscribe to room B does not skip the leave grace of room A on the same socket', async () => {
		const roomA = live.room({
			topic: () => 'scope-a',
			init: async () => [],
			presence: (ctx) => ({ name: ctx.user.name })
		});
		const roomB = live.room({
			topic: () => 'scope-b',
			init: async () => { throw new Error('boom'); },
			presence: (ctx) => ({ name: ctx.user.name })
		});
		__register('scope-a/__data', roomA.__dataStream);
		__register('scope-b/__data', roomB.__dataStream);

		const platform = mockPlatform();
		const ws = mockWs({ id: 'alice', name: 'Alice' });
		handleRpc(ws, toArrayBuffer({ rpc: 'scope-a/__data', id: 'a', args: [], stream: true }), platform);
		await settle();
		expect(_presenceRef.has('scope-a\0alice')).toBe(true);

		// Room B's loader throws after the socket is subscribed, so its
		// subscription is rolled back. Leave room A in the microtask right
		// after that rollback begins, while room B's rollback is in flight.
		const origUnsubscribe = ws.unsubscribe;
		ws.unsubscribe = (topic) => {
			if (topic === 'scope-b') queueMicrotask(() => unsubscribe(ws, 'scope-a', { platform }));
			return origUnsubscribe.call(ws, topic);
		};
		handleRpc(ws, toArrayBuffer({ rpc: 'scope-b/__data', id: 'b', args: [], stream: true }), platform);
		await settle();

		// Room B's own entry was released immediately (its rollback); room A's
		// leave rides the ordinary grace timer, so its roster entry is still held.
		expect(_presenceRef.has('scope-b\0alice')).toBe(false);
		expect(_presenceRef.has('scope-a\0alice')).toBe(true);

		close(ws, { platform });
		await settle();
	});
});

describe('claim barrier slots do not outlive the batch that consumed them', () => {
	let env;
	beforeEach(() => {
		env = createTestEnv();
		env.register('claims', {
			room: live.room({
				topic: (ctx, id) => 'claims:' + id,
				topicArgs: 1,
				init: async () => [],
				owner: true,
				presence: (ctx) => ({ name: ctx.user.name })
			})
		});
	});
	afterEach(() => env.cleanup());

	it('a data + presence + owner join batch leaves no slot behind on the socket', async () => {
		const topics = new Set();
		const responses = new Map();
		const ws = {
			getUserData: () => ({ id: 'alice', name: 'Alice' }),
			subscribe: (t) => { topics.add(t); return true; },
			unsubscribe: (t) => { topics.delete(t); return true; },
			isSubscribed: (t) => topics.has(t),
			getTopics: () => [...topics],
			_onSend: (topic, event, data) => { if (topic === '__rpc') responses.set(event, data); }
		};
		env.platform.connections++;
		handleRpc(ws, textEncoder.encode(JSON.stringify({ batch: [
			{ rpc: 'claims/room/__data', id: 'd', args: [1], stream: true },
			{ rpc: 'claims/room/__presence', id: 'p', args: [1], stream: true },
			{ rpc: 'claims/room/__owner', id: 'o', args: [1], stream: true }
		] })).buffer, env.platform);
		await settle();
		const byId = {};
		for (const r of responses.get('__batch').batch) byId[r.id] = r;
		expect(byId.p.data).toEqual([{ key: 'alice', data: { name: 'Alice' } }]);
		expect(byId.o.data).toEqual({ key: 'alice', reason: 'claimed' });
		// Both loaders consumed their slot; the settle after the join must not
		// have recreated either.
		expect(_claimSlotCountForTests(ws)).toBe(0);
	});
});
