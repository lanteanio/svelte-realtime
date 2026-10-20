// The harness client has to speak the attach frame the way a browser does,
// or an app test written against createTestEnv() cannot reproduce the window
// it exists to close: the server names the wire topic BEFORE it subscribes the
// socket, and a frame published while the loader is still awaiting arrives on
// a subscription whose listener must already be in place. The harness installs
// its listener from the attach frame, independently of socket subscription
// ownership, and fans out each delivered frame to every local listener.

import { describe, it, expect } from 'vitest';
import { live } from '../src/server.js';
import { createTestEnv } from '../src/testing.js';

const settle = (ms = 20) => new Promise((r) => setTimeout(r, ms));

function deferred() {
	let resolve;
	const promise = new Promise((r) => { resolve = r; });
	return { promise, resolve };
}

describe('test harness attach window', () => {
	it('delivers a frame published while the loader is still awaiting', async () => {
		const env = createTestEnv();
		const gate = deferred();
		env.register('feed', {
			items: live.stream(
				() => 'feed:1',
				async () => { await gate.promise; return []; },
				{ merge: 'latest' }
			)
		});
		const conn = env.connect({ id: 'u1' });
		const stream = conn.subscribe('feed/items');

		// The attach frame is out and the socket is subscribed; the loader is
		// parked on the app await. This is the window.
		await settle();
		expect(stream.topic).toBe('feed:1');
		env.platform.publish('feed:1', 'created', { id: 7 });

		gate.resolve();
		await settle();

		expect(stream.events.map((e) => e.data.id)).toEqual([7]);
		env.cleanup();
	});

	it('gives every subscription on one connection its own listener', async () => {
		const env = createTestEnv();
		env.register('feed', {
			items: live.stream(() => 'feed:2', async () => [], { merge: 'latest' })
		});
		const conn = env.connect({ id: 'u1' });
		const first = conn.subscribe('feed/items');
		const second = conn.subscribe('feed/items');
		await settle();

		env.platform.publish('feed:2', 'created', { id: 1 });
		await settle();

		expect(first.events.map((e) => e.data.id)).toEqual([1]);
		expect(second.events.map((e) => e.data.id)).toEqual([1]);
		env.cleanup();
	});

	it('a denied subscribe leaves no abandoned listener behind for the next subscriber', async () => {
		const env = createTestEnv();
		let allow = false;
		env.register('feed', {
			items: live.stream(
				() => 'feed:3',
				async () => {
					if (!allow) throw new Error('denied');
					return [];
				},
				{ merge: 'latest' }
			)
		});
		const conn = env.connect({ id: 'u1' });
		const denied = conn.subscribe('feed/items');
		await settle();
		expect(denied.error).toBeTruthy();

		allow = true;
		const ok = conn.subscribe('feed/items');
		await settle();
		env.platform.publish('feed:3', 'created', { id: 5 });
		await settle();

		// The second subscriber's own listener took the frame; the abandoned
		// one did not swallow it.
		expect(ok.events.map((e) => e.data.id)).toEqual([5]);
		env.cleanup();
	});
});

describe('test harness topic listener ownership', () => {
	it.each(['denial', 'subscribe throw'])('keeps the successful sibling when the first admission ends in %s', async failure => {
		const env = createTestEnv();
		const gate = deferred();
		const originalSubscribe = env.platform.subscribe;
		let admissions = 0;
		env.platform.subscribe = async (ws, topic) => {
			if (++admissions === 1) {
				await gate.promise;
				if (failure === 'denial') return 'FORBIDDEN';
				const subscribe = ws.subscribe;
				ws.subscribe = () => { throw new Error('socket rejected subscription'); };
				try { return await originalSubscribe(ws, topic); }
				finally { ws.subscribe = subscribe; }
			}
			return originalSubscribe(ws, topic);
		};
		env.register('shared', { feed: live.stream('shared:admission', async () => [], { merge: 'latest' }) });
		const conn = env.connect({ id: 'owner' });
		const denied = conn.subscribe('shared/feed');
		const survivor = conn.subscribe('shared/feed');
		try {
			await survivor.waitFor(Array.isArray);
			gate.resolve(); await settle();
			expect(denied.error?.code).toBe(failure === 'denial' ? 'FORBIDDEN' : 'CONNECTION_CLOSED');
			env.platform.publish('shared:admission', 'push', { id: 1 });
			env.platform.publish('shared:admission', 'push', { id: 2 });
			expect(survivor.value).toEqual([{ id: 1 }, { id: 2 }]);
			expect(survivor.events).toHaveLength(2);
			expect(denied.events).toHaveLength(0);
			expect(env.platform.subscribers('shared:admission')).toBe(1);
		} finally { gate.resolve(); conn.disconnect(); env.cleanup(); }
	});

	it('keeps sibling delivery after an earlier loader fails and rolls back its socket ref', async () => {
		const env = createTestEnv();
		const gate = deferred();
		env.register('shared', { feed: live.stream('shared:loader', async (_ctx, fail) => {
			if (fail) { await gate.promise; throw new Error('loader refused'); }
			return [];
		}, { merge: 'latest' }) });
		const conn = env.connect({ id: 'owner' });
		const denied = conn.subscribe('shared/feed', true);
		const survivor = conn.subscribe('shared/feed', false);
		try {
			await survivor.waitFor(Array.isArray);
			gate.resolve(); await settle();
			expect(denied.error).toBeTruthy();
			env.platform.publish('shared:loader', 'push', { id: 3 });
			expect(survivor.value).toEqual([{ id: 3 }]);
			expect(denied.events).toHaveLength(0);
			expect(env.platform.subscribers('shared:loader')).toBe(1);
		} finally { gate.resolve(); conn.disconnect(); env.cleanup(); }
	});

	it('fans out once per local listener and clears them before connection reuse', async () => {
		const env = createTestEnv();
		env.register('shared', { feed: live.stream('shared:fanout', async () => [], { merge: 'latest' }) });
		const first = env.connect({ id: 'one' });
		const second = env.connect({ id: 'two' });
		try {
			const a = first.subscribe('shared/feed');
			const b = first.subscribe('shared/feed');
			const c = second.subscribe('shared/feed');
			await Promise.all([a.waitFor(Array.isArray), b.waitFor(Array.isArray), c.waitFor(Array.isArray)]);
			expect(env.platform.subscribers('shared:fanout')).toBe(2);
			env.platform.publish('shared:fanout', 'push', { id: 1 });
			for (const stream of [a, b, c]) expect(stream.events).toHaveLength(1);
			first.disconnect(); first.reconnect();
			const fresh = first.subscribe('shared/feed');
			await fresh.waitFor(Array.isArray);
			env.platform.publish('shared:fanout', 'push', { id: 2 });
			expect(a.events).toHaveLength(1); expect(b.events).toHaveLength(1);
			expect(c.events).toHaveLength(2); expect(fresh.events).toHaveLength(1);
		} finally { first.disconnect(); second.disconnect(); env.cleanup(); }
	});
});
