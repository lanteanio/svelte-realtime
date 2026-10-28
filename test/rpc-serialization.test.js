import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readable, writable } from 'svelte/store';

const adapter = vi.hoisted(() => ({ conn: null }));
vi.mock('svelte-adapter-uws/client', () => ({
	connect: () => adapter.conn,
	status: { subscribe: (...args) => adapter.conn.status.subscribe(...args) }
}));
let rpc, batch, binary, state, devtools, frames;
beforeEach(async () => {
	vi.resetModules();
	vi.useFakeTimers();
	frames = [];
	const conn = {
		status: writable('open'), failure: readable(null),
		on: () => readable(undefined),
		sendQueued(value) { frames.push(JSON.parse(JSON.stringify(value))); },
		send(value) { frames.push(JSON.parse(JSON.stringify(value))); }
	};
	adapter.conn = conn;
	const api = await import('../src/client/rpc.js');
	rpc = api.__rpc('items/save');
	batch = api.batch;
	binary = api.__binaryRpc('items/binary');
	state = await import('../src/client/internal-state.js');
	devtools = (await import('../src/client/devtools-instrument.js')).__devtools;
});
afterEach(() => { vi.useRealTimers(); });

const values = {
	bigint: () => ({ value: 1n }),
	cycle: () => { const value = {}; value.self = value; return value; },
	toJSON: () => ({ toJSON() { throw new TypeError('cannot encode'); } })
};
const calls = {
	regular: value => rpc(value),
	fresh: value => rpc.fresh(value),
	options: value => rpc.with({ timeout: 50, idempotencyKey: 'save' })(value),
	offline: value => { state.clientState.isOffline = true; state.clientState.config.offline = { queue: true }; return rpc(value); },
	batch: value => batch(() => [rpc(value)]),
	binary: value => binary(new ArrayBuffer(1), value)
};

describe('RPC argument serialization', () => {
	for (const [kind, make] of Object.entries(values)) {
		for (const [entry, call] of Object.entries(calls)) {
			it(`${entry} rejects ${kind} before allocating a request`, async () => {
				let promise;
				promise = call(make());
				expect(promise).toBeInstanceOf(Promise);
				const error = await promise.catch(error => error);
				expect(error).toBeInstanceOf(state.RpcError);
				expect(error.code).toBe('INVALID_REQUEST');
				expect(error.cause).toBeInstanceOf(TypeError);
				expect(state.pending.size).toBe(0);
				expect(state._offlineQueue).toHaveLength(0);
				expect(frames).toHaveLength(0);
				expect(vi.getTimerCount()).toBe(0);
				const history = devtools.history.filter(Boolean);
				expect(history).toHaveLength(1);
				expect(history[0]).toMatchObject({ ok: false, result: { code: 'INVALID_REQUEST' } });
				vi.advanceTimersByTime(60000);
				expect(devtools.history.filter(Boolean)).toEqual(history);
			});
		}
	}
	it('retains the original thrown cause without exposing it in the public message', async () => {
		const cause = new Error('sensitive payload');
		await expect(rpc({ toJSON() { throw cause; } })).rejects.toMatchObject({ cause, message: 'RPC request could not be encoded or sent' });
	});
	it('cancels the whole unsent batch when one argument cannot serialize', async () => {
		await expect(batch(() => [rpc('valid'), rpc({ value: 1n })])).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
		expect(frames).toEqual([]);
		expect(state.pending.size).toBe(0);
		expect(devtools.pending.size).toBe(0);
		expect(vi.getTimerCount()).toBe(0);
	});
	it('takes a toJSON snapshot once for deduplication and transmission', async () => {
		const toJSON = vi.fn(() => ({ value: 'wire' }));
		const promise = rpc({ toJSON });
		expect(toJSON).toHaveBeenCalledTimes(1);
		expect(frames[0].args).toEqual([{ value: 'wire' }]);
		const entry = state.pending.get(frames[0].id);
		clearTimeout(entry.timer);
		state.pending.delete(frames[0].id);
		entry.resolve('ok');
		await expect(promise).resolves.toBe('ok');
	});
	it('validates arguments even when the idempotency key already has a pending call', async () => {
		const bound = rpc.with({ idempotencyKey: 'same' });
		const valid = bound('valid');
		await expect(bound(1n)).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
		expect(frames).toHaveLength(1);
		const entry = state.pending.get(frames[0].id);
		clearTimeout(entry.timer);
		state.pending.delete(frames[0].id);
		entry.resolve('ok');
		await valid;
	});
});

it('records cyclic invalid arguments safely with payload capture enabled', async () => {
	devtools.unsafeCapturePayloads = true;
	await expect(rpc(values.cycle())).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
	expect(state.pending.size).toBe(0);
	expect(devtools.pending.size).toBe(0);
	expect(devtools.history.filter(Boolean)[0].result.code).toBe('INVALID_REQUEST');
	expect(vi.getTimerCount()).toBe(0);
});

describe('serialized adapter sends', () => {
	function textSender() {
		adapter.conn.send = vi.fn(() => { throw new Error('object send should not run'); });
		adapter.conn.sendSerialized = vi.fn(text => { frames.push(JSON.parse(text)); return true; });
	}
	function answer() {
		const entry = state.pending.get(frames[0].id);
		clearTimeout(entry.timer);
		state.pending.delete(frames[0].id);
		entry.resolve('ok');
	}
	it('reuses validated argument text and quotes path and idempotency metadata', async () => {
		textSender();
		const api = await import('../src/client/rpc.js');
		const toJSON = vi.fn(() => ({ value: 'wire' }));
		const call = api.__rpc('items/"save').with({ idempotencyKey: 'key"\\\n' })({ toJSON });
		expect(toJSON).toHaveBeenCalledTimes(1);
		expect(frames[0]).toMatchObject({ rpc: 'items/"save', idempotencyKey: 'key"\\\n', args: [{ value: 'wire' }] });
		answer();
		await expect(call).resolves.toBe('ok');
	});
	it('keeps a refused text frame owned by its request and never sends after timeout', async () => {
		textSender();
		adapter.conn.sendSerialized.mockReturnValue(false);
		const call = rpc.with({ timeout: 25 })({ value: 1 });
		const rejected = expect(call).rejects.toMatchObject({ code: 'TIMEOUT' });
		expect([...state.pending.values()][0].rpcWaiting).toBe(true);
		await vi.advanceTimersByTimeAsync(25);
		await rejected;
		adapter.conn.status.set('connecting');
		adapter.conn.status.set('open');
		expect(adapter.conn.sendSerialized).toHaveBeenCalledTimes(1);
		expect(frames).toEqual([]);
		expect(state.pending.size).toBe(0);
	});
	it('delivers a parked snapshot once when the connection opens', async () => {
		textSender();
		adapter.conn.status.set('connecting');
		const value = { count: 1 };
		const call = rpc(value);
		value.count = 2;
		expect(frames).toEqual([]);
		adapter.conn.status.set('open');
		expect(frames[0].args).toEqual([{ count: 1 }]);
		answer();
		await expect(call).resolves.toBe('ok');
		adapter.conn.status.set('connecting');
		adapter.conn.status.set('open');
		expect(frames).toHaveLength(1);
	});
	for (const parked of [false, true]) {
		it('settles a throwing ' + (parked ? 'parked' : 'immediate') + ' text send without retaining timers', async () => {
			textSender();
			const cause = new TypeError('socket refused');
			adapter.conn.sendSerialized.mockImplementation(() => { throw cause; });
			if (parked) adapter.conn.status.set('connecting');
			const call = rpc({ value: 1 });
			const rejected = expect(call).rejects.toMatchObject({ code: 'INVALID_REQUEST', cause });
			if (parked) adapter.conn.status.set('open');
			await rejected;
			expect(state.pending.size).toBe(0);
			expect(devtools.pending.size).toBe(0);
			expect(vi.getTimerCount()).toBe(0);
		});
	}
});
