// A cursor sample, a presence field and a reaction are published under the
// caller's roster key. Driven through the real dispatch path: a connection that
// only watches the room (no data-stream subscribe) can put nothing on anyone's
// roster, cursors or reactions, while a member's sends land on its own entry.
// The test client's presence merge mirrors the browser client's.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { live, guard, LiveError, _presenceRefForTest } from '../src/server.js';
import { createTestEnv } from '../src/testing.js';
import { _resetStickyDropWarnings } from '../src/server/multiplayer.js';

const settle = (ms = 20) => new Promise((r) => setTimeout(r, ms));

describe('multiplayer sends through the real dispatch path come from members only', () => {
	let env;

	afterEach(() => {
		env.cleanup();
		vi.restoreAllMocks();
		_resetStickyDropWarnings();
	});

	function boardEnv() {
		env = createTestEnv();
		env.register('collab', {
			board: live.multiplayer({
				topic: (ctx, id) => 'board:' + id,
				topicArgs: 1,
				init: async () => [],
				presence: (ctx) => ({ name: ctx.user.name }),
				cursors: true,
				typing: true,
				locks: ['title'],
				reactions: true
			})
		});
	}

	it('a watcher puts nothing on the roster, the cursors or the reactions; a member\'s sends land on its entry', async () => {
		boardEnv();
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const alice = env.connect({ id: 'alice', name: 'Alice' });
		const bob = env.connect({ id: 'bob', name: 'Bob' });
		alice.subscribe('collab/board/__data', 'b1');
		const roster = alice.subscribe('collab/board/__presence', 'b1');
		const cursors = alice.subscribe('collab/board/__cursors', 'b1');
		const reactions = alice.subscribe('collab/board/__reactions', 'b1');
		// Bob looks on, as board.watch() does: the roster, no data stream.
		const bobsView = bob.subscribe('collab/board/__presence', 'b1');
		await settle();
		expect(roster.value).toEqual([{ key: 'alice', data: { name: 'Alice' } }]);

		await bob.call('collab/board/__presence/update', 'b1', { typing: true, 'lock:title': true });
		await bob.call('collab/board/__cursor/move', 'b1', { x: 1, y: 2 });
		await bob.call('collab/board/__reaction/emit', 'b1', 'wave');
		await settle();
		expect(roster.value).toEqual([{ key: 'alice', data: { name: 'Alice' } }]);
		expect(cursors.value).toEqual([]);
		expect(reactions.value).toEqual([]);
		expect(warn).toHaveBeenCalledTimes(1);

		await alice.call('collab/board/__presence/update', 'b1', { typing: true, 'lock:title': true });
		await alice.call('collab/board/__cursor/move', 'b1', { x: 3, y: 4 });
		await settle();
		const entry = { key: 'alice', data: { name: 'Alice' }, typing: true, 'lock:title': true };
		expect(roster.value).toEqual([entry]);
		expect(bobsView.value).toEqual([entry]);
		expect(cursors.value.map((c) => [c.key, c.x])).toEqual([['alice', 3]]);
	});

	it('a late joiner loads the lock a member took, and the member\'s later release reaches it', async () => {
		boardEnv();
		const alice = env.connect({ id: 'alice', name: 'Alice' });
		alice.subscribe('collab/board/__data', 'b2');
		alice.subscribe('collab/board/__presence', 'b2');
		await settle();
		await alice.call('collab/board/__presence/update', 'b2', { 'lock:title': true });

		const carol = env.connect({ id: 'carol', name: 'Carol' });
		carol.subscribe('collab/board/__data', 'b2');
		const roster = carol.subscribe('collab/board/__presence', 'b2');
		await settle();
		expect(roster.value.find((e) => e.key === 'alice')).toEqual({ key: 'alice', 'lock:title': true, data: { name: 'Alice' } });

		await alice.call('collab/board/__presence/update', 'b2', { 'lock:title': null });
		await settle();
		expect(roster.value.find((e) => e.key === 'alice')['lock:title']).toBe(null);
	});

	it('a module guard covers the send paths, as it does for the generated registry', async () => {
		env = createTestEnv();
		env.register('collab', {
			_guard: guard((ctx) => { if (ctx.user?.id === 'eve') throw new LiveError('FORBIDDEN', 'not here'); }),
			board: live.multiplayer({
				topic: (ctx, id) => 'board:' + id,
				topicArgs: 1,
				init: async () => [],
				presence: (ctx) => ({ name: ctx.user.name }),
				typing: true
			})
		});
		const alice = env.connect({ id: 'alice', name: 'Alice' });
		alice.subscribe('collab/board/__data', 'b4');
		const roster = alice.subscribe('collab/board/__presence', 'b4');
		await settle();
		// Eve holds a membership; the module guard still refuses her sends.
		_presenceRefForTest().set('board:b4\0eve', { count: 1, timer: null, data: { name: 'Eve' } });
		try {
			const eve = env.connect({ id: 'eve', name: 'Eve' });
			await expect(eve.call('collab/board/__presence/update', 'b4', { typing: true })).rejects.toThrow('not here');
			await settle();
			expect(roster.value.map((e) => e.key)).toEqual(['alice']);
		} finally {
			_presenceRefForTest().delete('board:b4\0eve');
		}
	});

	it('the test client merges presence frames as the browser client does when an update overtakes its join', async () => {
		boardEnv();
		const alice = env.connect({ id: 'alice', name: 'Alice' });
		alice.subscribe('collab/board/__data', 'b3');
		const roster = alice.subscribe('collab/board/__presence', 'b3');
		await settle();
		// Frames as a relay between instances may deliver them: a member's
		// update ahead of its join.
		env.platform.publish('board:b3:presence', 'update', { key: 'dan', typing: true, _p: 'x.1', _n: 1 });
		env.platform.publish('board:b3:presence', 'join', { key: 'dan', data: { name: 'Dan' } });
		await settle();
		expect(roster.value.find((e) => e.key === 'dan')).toEqual({ key: 'dan', data: { name: 'Dan' }, typing: true });
		// A repeated join replaces the joined entry.
		env.platform.publish('board:b3:presence', 'join', { key: 'dan', data: { name: 'Dan 2' } });
		await settle();
		expect(roster.value.find((e) => e.key === 'dan')).toEqual({ key: 'dan', data: { name: 'Dan 2' } });
	});
});
