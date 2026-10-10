import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { live, configureForget, _resetForget } from '../src/server.js';
import { state } from '../src/server/state.js';
import { createTestEnv } from '../src/testing.js';

describe('cursor samples follow room membership departures', () => {
	let env, originalCap;
	beforeEach(() => {
		vi.useFakeTimers();
		env = createTestEnv();
		originalCap = state.maxPresenceRef;
		env.register('board', {
			room: live.multiplayer({
				topic: (ctx, id) => 'cursor-board:' + id,
				topicArgs: 1,
				presence: ctx => ({ name: ctx.user.id }),
				cursors: true
			})
		});
	});
	afterEach(async () => {
		env.cleanup();
		await vi.advanceTimersByTimeAsync(5001);
		state.maxPresenceRef = originalCap;
		state.presenceRefWarnFired = false;
		_resetForget();
		vi.useRealTimers();
	});

	async function join(id) {
		const client = env.connect({ id });
		const stream = client.subscribe('board/room/__data', 'one');
		await vi.advanceTimersByTimeAsync(0);
		expect(stream.error).toBeNull();
		expect(stream.topic).toBe('cursor-board:one');
		return client;
	}

	async function watch(id) {
		const client = env.connect({ id });
		const stream = client.subscribe('board/room/__cursors', 'one');
		await vi.advanceTimersByTimeAsync(0);
		expect(stream.value).toEqual([]);
		return stream;
	}

	it('removes the departed cursor from every peer after the membership grace', async () => {
		const alice = await join('alice');
		const bob = await watch('bob');
		const carol = await watch('carol');
		await alice.call('board/room/__cursor/move', 'one', { x: 3, y: 4 });
		for (const peer of [bob, carol]) expect(peer.value).toEqual([expect.objectContaining({ key: 'alice', x: 3, y: 4 })]);
		alice.disconnect();
		await vi.advanceTimersByTimeAsync(4999);
		for (const peer of [bob, carol]) expect(peer.value).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(2);
		for (const peer of [bob, carol]) {
			expect(peer.value).toEqual([]);
			expect(peer.events.filter(e => e.event === 'remove')).toEqual([{ event: 'remove', data: { key: 'alice' } }]);
		}
	});

	it('keeps the cursor while another tab of that identity remains joined', async () => {
		const alice = await join('alice');
		const secondTab = await join('alice');
		const bob = await watch('bob');
		await alice.call('board/room/__cursor/move', 'one', { x: 5 });
		alice.disconnect();
		await vi.advanceTimersByTimeAsync(5001);
		expect(bob.value).toHaveLength(1);
		expect(bob.events.some(e => e.event === 'remove')).toBe(false);
		secondTab.disconnect();
		await vi.advanceTimersByTimeAsync(5001);
		expect(bob.value).toEqual([]);
	});

	it('keeps the cursor when the cluster still holds the identity on another replica', async () => {
		let count = 1;
		const remove = vi.fn(async () => 2);
		env.platform.redis = {
			hset: async () => 1,
			hincrby: async (key, field, by) => (count += by),
			expire: async () => 1,
			hdel: remove
		};
		const alice = await join('alice');
		const bob = await watch('bob');
		await alice.call('board/room/__cursor/move', 'one', { x: 5 });
		alice.disconnect();
		await vi.advanceTimersByTimeAsync(5001);
		expect(count).toBe(1);
		expect(remove).not.toHaveBeenCalled();
		expect(bob.value).toHaveLength(1);
		expect(bob.events.some(e => e.event === 'remove')).toBe(false);
	});

	it('removes the old room cursor when another room evicts its departing member', async () => {
		state.maxPresenceRef = 1;
		const alice = await join('alice');
		const bob = await watch('bob');
		await alice.call('board/room/__cursor/move', 'one', { x: 5 });
		alice.disconnect();
		await vi.advanceTimersByTimeAsync(0);
		env.register('other', { room: live.room({ topic: () => 'other-room', init: async () => [], presence: ctx => ({ name: ctx.user.id }) }) });
		const newcomer = env.connect({ id: 'newcomer' });
		const data = newcomer.subscribe('other/room/__data');
		await vi.advanceTimersByTimeAsync(0);
		expect(data.topic).toBe('other-room');
		expect(bob.value).toEqual([]);
		expect(bob.events.filter(e => e.event === 'remove')).toHaveLength(1);
	});

	it('removes the cursor during erasure through the normal forget entry point', async () => {
		const alice = await join('alice');
		const bob = await watch('bob');
		await alice.call('board/room/__cursor/move', 'one', { x: 5 });
		configureForget({ platform: env.platform, store: { purgeUser: async () => 0 } });
		await live.forget('alice');
		expect(bob.value).toEqual([]);
		expect(bob.events.filter(e => e.event === 'remove')).toHaveLength(1);
	});
});
