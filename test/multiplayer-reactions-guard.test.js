// The room guard has to gate the reactions sub-stream at the same place it
// gates the others: before the socket is subscribed at the wire. The reactions
// ring is built after live.room() has returned, so it is not in the sub-stream
// list room.js walks; with the guard only in its loader, a denied joiner holds
// a real subscription (and knows the resolved wire topic) for as long as the
// guard awaits, and every reaction published in that window is delivered to it
// before the rollback.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { live, LiveError } from '../src/server.js';
import { createTestEnv } from '../src/testing.js';
import { handleRpc } from '../src/server/dispatch.js';

const textEncoder = new TextEncoder();
const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));

function deferred() {
	let resolve;
	const promise = new Promise((r) => { resolve = r; });
	return { promise, resolve };
}

function openConn(env, userData, wire) {
	const topics = new Set();
	const ws = {
		getUserData: () => userData,
		subscribe: (t) => { topics.add(t); return true; },
		unsubscribe: (t) => { topics.delete(t); return true; },
		isSubscribed: (t) => topics.has(t),
		getTopics: () => [...topics],
		_onSend: (topic, event, data) => { wire.push({ to: userData.id, topic, event, data }); }
	};
	env.platform.connections++;
	return { ws, topics };
}

function send(conn, env, call) {
	handleRpc(conn.ws, textEncoder.encode(JSON.stringify(call)).buffer, env.platform);
}

describe('multiplayer reactions sub-stream guard', () => {
	let env, wire, malloryGate;

	beforeEach(() => {
		env = createTestEnv();
		wire = [];
		malloryGate = deferred();
		env.register('board', {
			room: live.multiplayer({
				topic: (ctx, id) => 'board:' + id,
				topicArgs: 1,
				reactions: true,
				presence: (ctx) => ({ name: ctx.user.name }),
				guard: async (ctx, id) => {
					if (ctx.user.id !== 'mallory') return;
					// The membership check an app would make against a store.
					await malloryGate.promise;
					throw new LiveError('FORBIDDEN', 'not a member');
				}
			})
		});
	});

	afterEach(() => {
		malloryGate.resolve();
		env.cleanup();
	});

	it('never subscribes a denied joiner to the reactions topic, not even while the guard awaits', async () => {
		const mallory = openConn(env, { id: 'mallory', name: 'Mallory' }, wire);
		send(mallory, env, { rpc: 'board/room/__reactions', id: 'x', args: ['r1'], stream: true, attach: true });
		await settle();

		// The guard is parked. The wire subscription must not exist yet, and the
		// resolved topic must not have been named to her.
		expect(mallory.topics.has('board:r1:reactions')).toBe(false);
		expect(wire.some((w) => w.data && w.data.attach === true)).toBe(false);

		malloryGate.resolve();
		await settle();

		expect(mallory.topics.has('board:r1:reactions')).toBe(false);
		const res = wire.find((w) => w.topic === '__rpc' && w.event === 'x');
		expect(res.data.ok).toBe(false);
		expect(res.data.code).toBe('FORBIDDEN');
	});

	it('admits a member and runs the room guard exactly once', async () => {
		let guardRuns = 0;
		env.cleanup();
		env = createTestEnv();
		wire = [];
		const room = live.multiplayer({
			topic: (ctx, id) => 'board:' + id,
			topicArgs: 1,
			reactions: true,
			presence: (ctx) => ({ name: ctx.user.name }),
			guard: async () => { guardRuns++; }
		});
		// The guard reaches the wire subscribe as a filter, not only as a loader
		// call: dispatch runs the filter before the attach frame and before the
		// subscribe, which is the whole point.
		expect(typeof room.__reactionStream.__streamFilter).toBe('function');
		env.register('board', { room });
		const alice = openConn(env, { id: 'alice', name: 'Alice' }, wire);
		send(alice, env, { rpc: 'board/room/__reactions', id: 'y', args: ['r2'], stream: true, attach: true });
		await settle();

		expect(alice.topics.has('board:r2:reactions')).toBe(true);
		const res = wire.find((w) => w.topic === '__rpc' && w.event === 'y' && w.data.ok);
		expect(res).toBeTruthy();
		expect(guardRuns).toBe(1);
	});
});
