import { afterEach, describe, expect, it, vi } from 'vitest';
import { live } from '../src/server.js';
import { createTestEnv } from '../src/testing.js';

const joined = (...streams) => Promise.all(streams.map(s => s.waitFor(v => v !== undefined)));
let env;
let connections;
afterEach(() => {
	for (const connection of connections ?? []) connection.disconnect();
	env?.cleanup();
});

function setup() {
	env = createTestEnv();
	connections = [];
	env.register('chat', {
		room: live.room({
			topic: (_ctx, id) => 'chat:' + id,
			topicArgs: 1,
			init: async () => [],
			presence: ctx => ({ name: ctx.user.name, email: ctx.user.email }),
			enumerable: true
		})
	});
	return (user) => {
		const client = env.connect(user);
		connections.push(client);
		return client;
	};
}

const byTopic = (list) => Object.fromEntries(list.map(r => [r.topic, r]));

describe('live.room lobby occupancy read', () => {
	it('reports per-room counts to a caller outside every room, without member identities', async () => {
		const connect = setup();
		const alice = connect({ id: 'a', name: 'Alice', email: 'alice@example.com' });
		const bob = connect({ id: 'b', name: 'Bob', email: 'bob@example.com' });
		const carol = connect({ id: 'c', name: 'Carol', email: 'carol@example.com' });
		await joined(
			alice.subscribe('chat/room/__data', 'general'),
			bob.subscribe('chat/room/__data', 'general'),
			carol.subscribe('chat/room/__data', 'random')
		);

		const viewer = connect({ id: 'v', name: 'Viewer' });
		const snapshot = await viewer.call('chat/room/__roomsSync');
		expect(byTopic(snapshot)).toEqual({
			'chat:general': { topic: 'chat:general', args: ['general'], count: 2, meta: undefined },
			'chat:random': { topic: 'chat:random', args: ['random'], count: 1, meta: undefined }
		});
		expect(JSON.stringify(snapshot)).not.toMatch(/Alice|Bob|Carol|example\.com/);

		const lobby = viewer.subscribe('chat/room/__rooms');
		await lobby.waitFor(v => Array.isArray(v));
		expect(byTopic(lobby.value)['chat:general'].count).toBe(2);
	});

	it('drops a room from the read once its last member leaves, so an empty room reads as absent', async () => {
		const connect = setup();
		const alice = connect({ id: 'a', name: 'Alice' });
		const bob = connect({ id: 'b', name: 'Bob' });
		await joined(alice.subscribe('chat/room/__data', 'general'), bob.subscribe('chat/room/__data', 'random'));

		const viewer = connect({ id: 'v', name: 'Viewer' });
		expect(byTopic(await viewer.call('chat/room/__roomsSync'))['chat:random'].count).toBe(1);

		bob.disconnect();
		await vi.waitFor(async () => {
			const after = byTopic(await viewer.call('chat/room/__roomsSync'));
			expect(after['chat:random']).toBeUndefined();
			expect(after['chat:general'].count).toBe(1);
		});
	});
});
