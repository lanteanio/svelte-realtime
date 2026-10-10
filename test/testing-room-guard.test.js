import { afterEach, describe, expect, it, vi } from 'vitest';
import { live, guard, LiveError } from '../src/server.js';
import { createTestEnv } from '../src/testing.js';

const settle = () => new Promise(resolve => setTimeout(resolve, 20));
const streams = ['board/__data', 'board/__presence', 'board/__owner', 'board/__cursors', 'board/__reactions', 'lobby/__rooms'];
let env;
let connections;
afterEach(() => {
	for (const connection of connections ?? []) connection.disconnect();
	env?.cleanup();
});

function setup() {
	env = createTestEnv();
	connections = [];
	const check = vi.fn(async ctx => {
		await Promise.resolve();
		if (!ctx.user.allowed) throw new LiveError('FORBIDDEN', 'Module refused');
		ctx.moduleAllowed = true;
	});
	const init = vi.fn(async ctx => {
		expect(ctx.moduleAllowed).toBe(true);
		return [{ id: 1 }];
	});
	const action = vi.fn(async ctx => ({ authorized: ctx.moduleAllowed === true }));
	env.register('guarded', {
		_guard: guard(check),
		board: live.multiplayer({
			topic: (_ctx, id) => 'guarded:' + id,
			topicArgs: 1,
			init,
			presence: ctx => ({ name: ctx.user.id }),
			cursors: true,
			reactions: true,
			owner: true,
			actions: { inspect: action }
		}),
		lobby: live.room({ topic: (_ctx, id) => 'lobby:' + id, topicArgs: 1, enumerable: true })
	});
	const connect = allowed => {
		const client = env.connect({ id: allowed ? 'member' : 'guest', allowed });
		connections.push(client);
		return client;
	};
	return { check, init, action, connect };
}

describe('test room module guards', () => {
	it.each(streams)('refuses %s before the harness attaches a topic or runs the loader', async suffix => {
		const { check, init, action, connect } = setup();
		const stream = connect(false).subscribe('guarded/' + suffix, 'one');
		await settle();
		expect(stream.error?.code).toBe('FORBIDDEN');
		expect(stream.topic).toBeNull();
		expect(stream.value).toBeUndefined();
		expect(check).toHaveBeenCalledTimes(1);
		expect(init).not.toHaveBeenCalled();
		expect(action).not.toHaveBeenCalled();
	});

	it.each(['lobby/__roomsSync', 'board/__action/inspect'])('refuses the %s RPC through the same module guard', async suffix => {
		const { check, action, connect } = setup();
		await expect(connect(false).call('guarded/' + suffix, 'one')).rejects.toMatchObject({ code: 'FORBIDDEN' });
		expect(check).toHaveBeenCalledTimes(1);
		expect(action).not.toHaveBeenCalled();
	});

	it('admits every room surface and carries guard context into the loader and action', async () => {
		const { check, init, action, connect } = setup();
		const client = connect(true);
		const active = streams.map(suffix => client.subscribe('guarded/' + suffix, 'one'));
		await settle();
		for (const stream of active) {
			expect(stream.error).toBeNull();
			expect(stream.value).not.toBeUndefined();
		}
		await expect(client.call('guarded/lobby/__roomsSync')).resolves.toEqual(expect.any(Array));
		await expect(client.call('guarded/board/__action/inspect', 'one')).resolves.toEqual({ authorized: true });
		expect(check).toHaveBeenCalledTimes(8);
		expect(init).toHaveBeenCalledTimes(1);
		expect(action).toHaveBeenCalledTimes(1);
	});
});
