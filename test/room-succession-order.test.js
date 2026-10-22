import { afterEach, describe, expect, it, vi } from 'vitest';
import { live } from '../src/server.js';
import { createTestEnv } from '../src/testing.js';
import { _presenceRef, state } from '../src/server/state.js';

// When the owner's last connection leaves a room, the owner stream names the
// successor before the presence stream drops the departed owner, so a client
// reacting to the roster change never reads the departed key as the owner.

let env;
const cap = state.maxPresenceRef;
afterEach(() => {
	env?.cleanup();
	state.maxPresenceRef = cap;
	for (const ref of _presenceRef.values()) if (ref.timer) clearTimeout(ref.timer);
	_presenceRef.clear();
	vi.useRealTimers();
});

describe('owner succession order', () => {
	it.each(['room', 'multiplayer'])('a %s publishes the successor before the departed owner leaves the roster', async (kind) => {
		vi.useFakeTimers();
		env = createTestEnv();
		const config = { topic: (ctx, id) => kind + ':' + id, topicArgs: 1, init: async () => [], presence: ctx => ({ name: ctx.user.id }), owner: true };
		env.register('succ', { board: kind === 'room' ? live.room(config) : live.multiplayer(config) });
		const alice = env.connect({ id: 'alice' });
		const bob = env.connect({ id: 'bob' });
		// Each joins as a room view does: the data stream with the presence
		// and owner streams beside it.
		alice.subscribe('succ/board/__data', 'r');
		alice.subscribe('succ/board/__presence', 'r');
		alice.subscribe('succ/board/__owner', 'r');
		await vi.advanceTimersByTimeAsync(0);
		bob.subscribe('succ/board/__data', 'r');
		const roster = bob.subscribe('succ/board/__presence', 'r');
		const owner = bob.subscribe('succ/board/__owner', 'r');
		await vi.advanceTimersByTimeAsync(0);
		expect(owner.value).toMatchObject({ key: 'alice' });
		expect(roster.value.map(entry => entry.key).sort()).toEqual(['alice', 'bob']);
		// Publish order is the order every subscriber's socket delivers in.
		const seen = [];
		const publish = env.platform.publish;
		env.platform.publish = (topic, event, data, options) => {
			if (topic === kind + ':r:owner') seen.push(['owner', data?.key]);
			if (topic === kind + ':r:presence' && event === 'leave') seen.push(['leave', data?.key]);
			return publish(topic, event, data, options);
		};
		alice.disconnect();
		await vi.advanceTimersByTimeAsync(10000);
		expect(seen).toEqual([['owner', 'bob'], ['leave', 'alice']]);
		expect(roster.value.map(entry => entry.key)).toEqual(['bob']);
		expect(owner.value).toMatchObject({ key: 'bob' });
	});

	it('a departing owner retired early to admit a member at capacity is succeeded before it leaves the roster', async () => {
		vi.useFakeTimers();
		env = createTestEnv();
		env.register('cap', { board: live.room({ topic: (ctx, id) => 'cap:' + id, topicArgs: 1, init: async () => [], presence: ctx => ({ name: ctx.user.id }), owner: true }) });
		const join = async (id) => {
			const client = env.connect({ id });
			client.subscribe('cap/board/__data', 'r');
			const roster = client.subscribe('cap/board/__presence', 'r');
			const owner = client.subscribe('cap/board/__owner', 'r');
			await vi.advanceTimersByTimeAsync(0);
			return { client, roster, owner };
		};
		const alice = await join('alice');
		const bob = await join('bob');
		expect(bob.owner.value).toMatchObject({ key: 'alice' });
		state.maxPresenceRef = 2;
		const seen = [];
		const publish = env.platform.publish;
		env.platform.publish = (topic, event, data, options) => {
			if (topic === 'cap:r:owner') seen.push(['owner', data?.key]);
			if (topic === 'cap:r:presence' && event === 'leave') seen.push(['leave', data?.key]);
			return publish(topic, event, data, options);
		};
		// Alice is in her grace window when Carol arrives at a full map.
		alice.client.disconnect();
		await vi.advanceTimersByTimeAsync(10);
		expect(seen).toEqual([]);
		await join('carol');
		expect(seen).toEqual([['owner', 'bob'], ['leave', 'alice']]);
		expect(bob.owner.value).toMatchObject({ key: 'bob' });
	});
});
