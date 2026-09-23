// The harness client has to speak the attach frame the way a browser does,
// or an app test written against createTestEnv() cannot reproduce the window
// it exists to close: the server names the wire topic BEFORE it subscribes the
// socket, and a frame published while the loader is still awaiting arrives on
// a subscription whose listener must already be in place. The harness installs
// its listener from the attach frame, but at that moment the socket is not
// subscribed yet and there is no entry to claim, so the listener parks until
// the subscribe binds it.

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

	it('a denied subscribe leaves no parked listener behind for the next subscriber', async () => {
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
