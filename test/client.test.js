import { describe, it, expect, vi, beforeEach } from 'vitest';

let __rpc, __stream, __binaryRpc, RpcError, batch, configure, combine, onSignal;
let topicCallbacks;
let statusCallbacks;
let sendQueuedFn;

/**
 * Simulate an RPC response arriving from the server.
 */
function simulateRpcResponse(correlationId, payload) {
	const cb = topicCallbacks.get('__rpc');
	if (cb) cb({ event: correlationId, data: payload });
}

/**
 * Simulate a pub/sub message on a topic.
 */
function simulateTopicMessage(topic, envelope) {
	const cb = topicCallbacks.get(topic);
	if (cb) cb(envelope);
}

/**
 * Simulate a connection status change.
 */
function simulateStatus(s) {
	for (const cb of statusCallbacks) cb(s);
}

beforeEach(async () => {
	vi.resetModules();

	topicCallbacks = new Map();
	statusCallbacks = new Set();
	sendQueuedFn = vi.fn();

	vi.doMock('svelte-adapter-uws/client', () => ({
		connect: () => ({ sendQueued: sendQueuedFn }),
		on: (topic) => ({
			subscribe: (fn) => {
				topicCallbacks.set(topic, fn);
				return () => topicCallbacks.delete(topic);
			}
		}),
		status: {
			subscribe: (fn) => {
				statusCallbacks.add(fn);
				fn('open');
				return () => statusCallbacks.delete(fn);
			}
		}
	}));

	vi.doMock('svelte/store', () => ({
		writable: (initial) => {
			let value = initial;
			const subs = new Set();
			return {
				set(v) { value = v; for (const fn of subs) fn(v); },
				subscribe(fn) { subs.add(fn); fn(value); return () => subs.delete(fn); }
			};
		}
	}));

	const mod = await import('../client.js');
	__rpc = mod.__rpc;
	__stream = mod.__stream;
	__binaryRpc = mod.__binaryRpc;
	RpcError = mod.RpcError;
	batch = mod.batch;
	configure = mod.configure;
	combine = mod.combine;
	onSignal = mod.onSignal;
});

// -- __rpc (Finding 1 regression) ---------------------------------------------

describe('__rpc()', () => {
	it('resolves with unwrapped data.data for regular RPC', async () => {
		const call = __rpc('chat/send');
		const promise = call('hello');

		// The call sends a message; extract the correlation ID
		const sent = sendQueuedFn.mock.calls[0][0];
		expect(sent.rpc).toBe('chat/send');

		simulateRpcResponse(sent.id, { ok: true, data: { id: 1, text: 'hello' } });

		const result = await promise;
		expect(result).toEqual({ id: 1, text: 'hello' });
	});

	it('rejects with RpcError on failure', async () => {
		const call = __rpc('test/fail');
		const promise = call();

		const sent = sendQueuedFn.mock.calls[0][0];
		simulateRpcResponse(sent.id, { ok: false, code: 'FORBIDDEN', error: 'Nope' });

		await expect(promise).rejects.toThrow('Nope');
		await expect(promise).rejects.toMatchObject({ code: 'FORBIDDEN' });
	});
});

// -- __stream (Findings 1, 3, 4, 5) ------------------------------------------

describe('__stream()', () => {
	it('resolves with full response (topic + data) for stream requests', () => {
		const store = __stream('chat/messages', { merge: 'crud', key: 'id' });
		const values = [];
		const unsub = store.subscribe((v) => values.push(v));

		// Extract the sent message to get the correlation ID
		const sent = sendQueuedFn.mock.calls[0][0];
		expect(sent.stream).toBe(true);

		// Simulate server stream response with topic
		simulateRpcResponse(sent.id, {
			ok: true,
			data: [{ id: 1, text: 'hi' }],
			topic: 'messages',
			merge: 'crud',
			key: 'id'
		});

		// Store should have the data, and topic subscription should be active
		const lastValue = values[values.length - 1];
		expect(lastValue).toEqual([{ id: 1, text: 'hi' }]);
		expect(topicCallbacks.has('messages')).toBe(true);

		unsub();
	});

	it('receives live updates after initial load', () => {
		const store = __stream('items/list', { merge: 'crud', key: 'id' });
		const values = [];
		const unsub = store.subscribe((v) => values.push(v));

		const sent = sendQueuedFn.mock.calls[0][0];
		simulateRpcResponse(sent.id, {
			ok: true,
			data: [{ id: 1, name: 'A' }],
			topic: 'items',
			merge: 'crud',
			key: 'id'
		});

		// Simulate a live 'created' event
		simulateTopicMessage('items', { event: 'created', data: { id: 2, name: 'B' } });

		const lastValue = values[values.length - 1];
		expect(lastValue).toEqual([{ id: 1, name: 'A' }, { id: 2, name: 'B' }]);

		unsub();
	});

	it('uses server-provided options over build-time defaults (Finding 5)', () => {
		// Build-time says merge:'crud' key:'id', server overrides with key:'uid'
		const store = __stream('users/list', { merge: 'crud', key: 'id' });
		const values = [];
		const unsub = store.subscribe((v) => values.push(v));

		const sent = sendQueuedFn.mock.calls[0][0];
		simulateRpcResponse(sent.id, {
			ok: true,
			data: [{ uid: 'a', name: 'Alice' }],
			topic: 'users',
			merge: 'crud',
			key: 'uid'
		});

		// Update using server-provided key 'uid'
		simulateTopicMessage('users', {
			event: 'updated',
			data: { uid: 'a', name: 'Alice Updated' }
		});

		const lastValue = values[values.length - 1];
		expect(lastValue).toEqual([{ uid: 'a', name: 'Alice Updated' }]);

		unsub();
	});

	it('latest merge pushes raw data, not envelopes (Finding 4)', () => {
		const store = __stream('activity/feed', { merge: 'latest', max: 10 });
		const values = [];
		const unsub = store.subscribe((v) => values.push(v));

		const sent = sendQueuedFn.mock.calls[0][0];
		simulateRpcResponse(sent.id, {
			ok: true,
			data: [{ type: 'login', user: 'Alice' }],
			topic: 'activity',
			merge: 'latest',
			max: 10
		});

		simulateTopicMessage('activity', {
			event: 'action',
			data: { type: 'logout', user: 'Alice' }
		});

		const lastValue = values[values.length - 1];
		// Should be raw data items, not { event, data } envelopes
		expect(lastValue).toEqual([
			{ type: 'login', user: 'Alice' },
			{ type: 'logout', user: 'Alice' }
		]);

		unsub();
	});

	it('cleanup removes pending entry from shared map (Finding 3)', () => {
		const store = __stream('temp/data', { merge: 'set' });
		const unsub = store.subscribe(() => {});

		// There should be a pending entry (the stream fetch)
		const sent = sendQueuedFn.mock.calls[0][0];
		expect(sent.stream).toBe(true);

		// Unsubscribe before the server responds - cleanup should remove pending
		unsub();

		// Simulate a late response - should be ignored (no crash, no side effects)
		simulateRpcResponse(sent.id, {
			ok: true,
			data: { count: 42 },
			topic: 'temp'
		});

		// No topic subscription should have been created
		expect(topicCallbacks.has('temp')).toBe(false);
	});

	it('reconnects after disconnect during initial load (Finding 3)', async () => {
		const store = __stream('recover/data', { merge: 'set' });
		const values = [];
		const unsub = store.subscribe((v) => values.push(v));

		const firstSent = sendQueuedFn.mock.calls[0][0];

		// Disconnect before the initial load completes
		simulateStatus('closed');

		// The disconnect listener rejects pending entries
		// Store should have an error
		const afterDisconnect = values[values.length - 1];
		expect(afterDisconnect).toHaveProperty('error');

		// Reconnect (debounced -- wait for it)
		simulateStatus('open');
		await new Promise((r) => setTimeout(r, 60));

		// Should have re-fetched (second sendQueued call)
		expect(sendQueuedFn).toHaveBeenCalledTimes(2);
		const secondSent = sendQueuedFn.mock.calls[1][0];
		expect(secondSent.stream).toBe(true);

		// Now the second request succeeds
		simulateRpcResponse(secondSent.id, {
			ok: true,
			data: { status: 'recovered' },
			topic: 'recover'
		});

		const lastValue = values[values.length - 1];
		expect(lastValue).toEqual({ status: 'recovered' });

		unsub();
	});
});

// -- __stream() optimistic updates (Phase 7) ----------------------------------

describe('__stream() optimistic', () => {
	it('optimistic created immediately adds item to store', () => {
		const store = __stream('opt/items', { merge: 'crud', key: 'id' });
		const values = [];
		const unsub = store.subscribe((v) => values.push(v));

		const sent = sendQueuedFn.mock.calls[0][0];
		simulateRpcResponse(sent.id, {
			ok: true,
			data: [{ id: 1, name: 'A' }],
			topic: 'opt-items',
			merge: 'crud',
			key: 'id'
		});

		// Apply optimistic create
		const rollback = store.optimistic('created', { id: 'temp', name: 'Optimistic' });
		const afterOpt = values[values.length - 1];
		expect(afterOpt).toEqual([{ id: 1, name: 'A' }, { id: 'temp', name: 'Optimistic' }]);

		// Rollback
		rollback();
		const afterRollback = values[values.length - 1];
		expect(afterRollback).toEqual([{ id: 1, name: 'A' }]);

		unsub();
	});

	it('server event with same key replaces optimistic entry (no duplicate)', () => {
		const store = __stream('opt/dedup', { merge: 'crud', key: 'id' });
		const values = [];
		const unsub = store.subscribe((v) => values.push(v));

		const sent = sendQueuedFn.mock.calls[0][0];
		simulateRpcResponse(sent.id, {
			ok: true,
			data: [],
			topic: 'opt-dedup',
			merge: 'crud',
			key: 'id'
		});

		// Add optimistic item
		store.optimistic('created', { id: 'temp-1', name: 'Pending' });

		// Server publishes created with the same key
		simulateTopicMessage('opt-dedup', {
			event: 'created',
			data: { id: 'temp-1', name: 'Confirmed' }
		});

		const last = values[values.length - 1];
		// Should replace, not duplicate
		expect(last).toEqual([{ id: 'temp-1', name: 'Confirmed' }]);

		unsub();
	});

	it('optimistic set replaces value, rollback restores', () => {
		const store = __stream('opt/set', { merge: 'set' });
		const values = [];
		const unsub = store.subscribe((v) => values.push(v));

		const sent = sendQueuedFn.mock.calls[0][0];
		simulateRpcResponse(sent.id, {
			ok: true,
			data: { count: 10 },
			topic: 'opt-set-topic',
			merge: 'set'
		});

		const rollback = store.optimistic('set', { count: 11 });
		expect(values[values.length - 1]).toEqual({ count: 11 });

		rollback();
		expect(values[values.length - 1]).toEqual({ count: 10 });

		unsub();
	});

	it('optimistic updated snapshots previous, rollback restores', () => {
		const store = __stream('opt/upd', { merge: 'crud', key: 'id' });
		const values = [];
		const unsub = store.subscribe((v) => values.push(v));

		const sent = sendQueuedFn.mock.calls[0][0];
		simulateRpcResponse(sent.id, {
			ok: true,
			data: [{ id: 1, name: 'Old' }],
			topic: 'opt-upd-topic',
			merge: 'crud',
			key: 'id'
		});

		const rollback = store.optimistic('updated', { id: 1, name: 'New' });
		expect(values[values.length - 1]).toEqual([{ id: 1, name: 'New' }]);

		rollback();
		expect(values[values.length - 1]).toEqual([{ id: 1, name: 'Old' }]);

		unsub();
	});
});

// -- __stream() dynamic topics ------------------------------------------------

describe('__stream() dynamic topics', () => {
	it('returns a function when isDynamic is true', () => {
		const factory = __stream('rooms/messages', { merge: 'crud', key: 'id' }, true);
		expect(typeof factory).toBe('function');
	});

	it('different args produce separate stores', () => {
		const factory = __stream('rooms/msgs', { merge: 'crud', key: 'id' }, true);

		const store1 = factory('room-1');
		const store2 = factory('room-2');
		expect(store1).not.toBe(store2);
	});

	it('same args return the same cached store', () => {
		const factory = __stream('rooms/cached', { merge: 'crud', key: 'id' }, true);

		const store1 = factory('room-1');
		const store2 = factory('room-1');
		expect(store1).toBe(store2);
	});

	it('sends args in the stream request', () => {
		const factory = __stream('rooms/withargs', { merge: 'crud', key: 'id' }, true);
		const store = factory('room-42');
		const unsub = store.subscribe(() => {});

		const sent = sendQueuedFn.mock.calls[0][0];
		expect(sent.rpc).toBe('rooms/withargs');
		expect(sent.args).toEqual(['room-42']);
		expect(sent.stream).toBe(true);

		unsub();
	});
});

// -- batch() ------------------------------------------------------------------

describe('batch()', () => {
	it('collects RPC calls and sends as single frame', async () => {
		const add = __rpc('math/add');
		const mul = __rpc('math/mul');

		const promise = batch(() => [add(2, 3), mul(4, 5)]);

		// Should send one frame with batch array
		expect(sendQueuedFn).toHaveBeenCalledTimes(1);
		const sent = sendQueuedFn.mock.calls[0][0];
		expect(sent.batch).toHaveLength(2);
		expect(sent.batch[0].rpc).toBe('math/add');
		expect(sent.batch[1].rpc).toBe('math/mul');

		// Simulate batch response
		const batchCb = topicCallbacks.get('__rpc');
		batchCb({
			event: '__batch',
			data: {
				batch: [
					{ id: sent.batch[0].id, ok: true, data: 5 },
					{ id: sent.batch[1].id, ok: true, data: 20 }
				]
			}
		});

		const results = await promise;
		expect(results).toEqual([5, 20]);
	});

	it('individual promises reject independently on failure', async () => {
		const ok = __rpc('batch/ok');
		const fail = __rpc('batch/fail');

		const promise = batch(() => [ok(), fail()]);

		const sent = sendQueuedFn.mock.calls[0][0];

		const batchCb = topicCallbacks.get('__rpc');
		batchCb({
			event: '__batch',
			data: {
				batch: [
					{ id: sent.batch[0].id, ok: true, data: 'good' },
					{ id: sent.batch[1].id, ok: false, code: 'FAIL', error: 'oops' }
				]
			}
		});

		await expect(promise).rejects.toThrow('oops');
	});

	it('passes sequential flag to server', async () => {
		const fn = __rpc('seq/test');

		batch(() => [fn()], { sequential: true });

		const sent = sendQueuedFn.mock.calls[0][0];
		expect(sent.sequential).toBe(true);
	});

	it('omits sequential flag when not requested', async () => {
		const fn = __rpc('noseq/test');

		batch(() => [fn()]);

		const sent = sendQueuedFn.mock.calls[0][0];
		expect(sent.sequential).toBeUndefined();
	});

	it('returns empty array for empty batch', async () => {
		const result = await batch(() => []);
		expect(result).toEqual([]);
		expect(sendQueuedFn).not.toHaveBeenCalled();
	});
});

// -- __stream() presence merge (Phase 9) --------------------------------------

describe('__stream() presence merge', () => {
	it('join adds to presence list', () => {
		const store = __stream('room/presence', { merge: 'presence' });
		const values = [];
		const unsub = store.subscribe((v) => values.push(v));

		const sent = sendQueuedFn.mock.calls[0][0];
		simulateRpcResponse(sent.id, {
			ok: true,
			data: [],
			topic: 'presence-room',
			merge: 'presence'
		});

		simulateTopicMessage('presence-room', { event: 'join', data: { key: 'user1', name: 'Alice' } });
		expect(values[values.length - 1]).toEqual([{ key: 'user1', name: 'Alice' }]);

		simulateTopicMessage('presence-room', { event: 'join', data: { key: 'user2', name: 'Bob' } });
		expect(values[values.length - 1]).toEqual([
			{ key: 'user1', name: 'Alice' },
			{ key: 'user2', name: 'Bob' }
		]);

		unsub();
	});

	it('join with existing key updates in place', () => {
		const store = __stream('room/upd', { merge: 'presence' });
		const values = [];
		const unsub = store.subscribe((v) => values.push(v));

		const sent = sendQueuedFn.mock.calls[0][0];
		simulateRpcResponse(sent.id, {
			ok: true,
			data: [{ key: 'u1', status: 'online' }],
			topic: 'pres-upd',
			merge: 'presence'
		});

		simulateTopicMessage('pres-upd', { event: 'join', data: { key: 'u1', status: 'away' } });
		expect(values[values.length - 1]).toEqual([{ key: 'u1', status: 'away' }]);

		unsub();
	});

	it('leave removes from presence list', () => {
		const store = __stream('room/leave', { merge: 'presence' });
		const values = [];
		const unsub = store.subscribe((v) => values.push(v));

		const sent = sendQueuedFn.mock.calls[0][0];
		simulateRpcResponse(sent.id, {
			ok: true,
			data: [{ key: 'u1', name: 'Alice' }, { key: 'u2', name: 'Bob' }],
			topic: 'pres-leave',
			merge: 'presence'
		});

		simulateTopicMessage('pres-leave', { event: 'leave', data: { key: 'u1' } });
		expect(values[values.length - 1]).toEqual([{ key: 'u2', name: 'Bob' }]);

		unsub();
	});

	it('set replaces entire presence list', () => {
		const store = __stream('room/set', { merge: 'presence' });
		const values = [];
		const unsub = store.subscribe((v) => values.push(v));

		const sent = sendQueuedFn.mock.calls[0][0];
		simulateRpcResponse(sent.id, {
			ok: true,
			data: [{ key: 'u1' }],
			topic: 'pres-set',
			merge: 'presence'
		});

		simulateTopicMessage('pres-set', { event: 'set', data: [{ key: 'u3' }, { key: 'u4' }] });
		expect(values[values.length - 1]).toEqual([{ key: 'u3' }, { key: 'u4' }]);

		unsub();
	});
});

// -- __stream() cursor merge (Phase 9) ----------------------------------------

describe('__stream() cursor merge', () => {
	it('update adds or replaces cursor entry', () => {
		const store = __stream('doc/cursors', { merge: 'cursor' });
		const values = [];
		const unsub = store.subscribe((v) => values.push(v));

		const sent = sendQueuedFn.mock.calls[0][0];
		simulateRpcResponse(sent.id, {
			ok: true,
			data: [],
			topic: 'cursors-doc',
			merge: 'cursor'
		});

		simulateTopicMessage('cursors-doc', { event: 'update', data: { key: 'u1', x: 10, y: 20 } });
		expect(values[values.length - 1]).toEqual([{ key: 'u1', x: 10, y: 20 }]);

		simulateTopicMessage('cursors-doc', { event: 'update', data: { key: 'u1', x: 15, y: 25 } });
		expect(values[values.length - 1]).toEqual([{ key: 'u1', x: 15, y: 25 }]);

		unsub();
	});

	it('remove deletes cursor entry', () => {
		const store = __stream('doc/rm', { merge: 'cursor' });
		const values = [];
		const unsub = store.subscribe((v) => values.push(v));

		const sent = sendQueuedFn.mock.calls[0][0];
		simulateRpcResponse(sent.id, {
			ok: true,
			data: [{ key: 'u1', x: 0, y: 0 }],
			topic: 'cursors-rm',
			merge: 'cursor'
		});

		simulateTopicMessage('cursors-rm', { event: 'remove', data: { key: 'u1' } });
		expect(values[values.length - 1]).toEqual([]);

		unsub();
	});

	it('set replaces all cursors', () => {
		const store = __stream('doc/cset', { merge: 'cursor' });
		const values = [];
		const unsub = store.subscribe((v) => values.push(v));

		const sent = sendQueuedFn.mock.calls[0][0];
		simulateRpcResponse(sent.id, {
			ok: true,
			data: [{ key: 'old' }],
			topic: 'cursors-cset',
			merge: 'cursor'
		});

		simulateTopicMessage('cursors-cset', { event: 'set', data: [{ key: 'new1' }, { key: 'new2' }] });
		expect(values[values.length - 1]).toEqual([{ key: 'new1' }, { key: 'new2' }]);

		unsub();
	});
});

// -- __stream() hydrate (Phase 11) --------------------------------------------

describe('__stream() hydrate', () => {
	it('sets initial data from SSR before subscribing to live updates', () => {
		const store = __stream('ssr/items', { merge: 'crud', key: 'id' });
		store.hydrate([{ id: 1, name: 'SSR Item' }]);

		const values = [];
		const unsub = store.subscribe((v) => values.push(v));

		// First value should be the hydrated data, not undefined
		expect(values[0]).toEqual([{ id: 1, name: 'SSR Item' }]);

		unsub();
	});

	it('returns the same store for chaining', () => {
		const store = __stream('ssr/chain', { merge: 'set' });
		const result = store.hydrate({ count: 0 });
		expect(result).toBe(store);
	});
});

// -- __stream() seq tracking (Phase 15) ---------------------------------------

describe('__stream() seq tracking', () => {
	it('sends seq on reconnect request', async () => {
		const store = __stream('seq/data', { merge: 'crud', key: 'id' });
		const values = [];
		const unsub = store.subscribe((v) => values.push(v));

		const sent1 = sendQueuedFn.mock.calls[0][0];
		simulateRpcResponse(sent1.id, {
			ok: true,
			data: [{ id: 1 }],
			topic: 'seq-topic',
			merge: 'crud',
			key: 'id',
			seq: 10
		});

		// Simulate seq from a pub/sub event
		simulateTopicMessage('seq-topic', { event: 'created', data: { id: 2 }, seq: 11 });

		// Disconnect and reconnect (debounced -- wait for it)
		simulateStatus('closed');
		simulateStatus('open');
		await new Promise((r) => setTimeout(r, 60));

		// Second request should include seq
		expect(sendQueuedFn.mock.calls.length).toBeGreaterThanOrEqual(2);
		const sent2 = sendQueuedFn.mock.calls[sendQueuedFn.mock.calls.length - 1][0];
		expect(sent2.seq).toBe(11);

		unsub();
	});
});

// -- __rpc() issues propagation -----------------------------------------------

describe('__rpc() issues', () => {
	it('propagates issues array on RpcError', async () => {
		const call = __rpc('val/check');
		const promise = call({ name: '' });

		const sent = sendQueuedFn.mock.calls[0][0];
		simulateRpcResponse(sent.id, {
			ok: false,
			code: 'VALIDATION',
			error: 'Validation failed',
			issues: [{ path: ['name'], message: 'Required' }]
		});

		try {
			await promise;
		} catch (err) {
			expect(err).toBeInstanceOf(RpcError);
			expect(err.code).toBe('VALIDATION');
			expect(err.issues).toEqual([{ path: ['name'], message: 'Required' }]);
		}
	});
});

// -- Phase 16 Bug #4: Dynamic stream subscribe wrapper stability ---------------

describe('__stream() dynamic subscribe wrapper (Bug #4 fix)', () => {
	it('does not nest wrappers on repeated cache hits', () => {
		const factory = __stream('bug4/test', { merge: 'crud', key: 'id' }, true);

		// First access creates the store and wraps subscribe
		const store1 = factory('room-1');
		const unsub1 = store1.subscribe(() => {});

		// Second access returns the same cached store
		const store2 = factory('room-1');
		expect(store2).toBe(store1);

		// Subscribe again -- should not create nested wrappers
		const unsub2 = store2.subscribe(() => {});

		unsub1();
		unsub2();
	});
});

// -- Phase 16 Bug #5: batch() cleanup on throw --------------------------------

describe('batch() cleanup on throw (Bug #5 fix)', () => {
	it('cleans up if fn() throws synchronously', () => {
		expect(() => {
			batch(() => { throw new Error('sync boom'); });
		}).toThrow('sync boom');

		// Subsequent batch should work fine (no leftover state)
		const fn = __rpc('batch/ok2');
		const promise = batch(() => [fn()]);
		expect(sendQueuedFn).toHaveBeenCalled();
	});
});

// -- Phase 19: Stream pagination (client) -------------------------------------

describe('__stream() pagination', () => {
	it('tracks hasMore and cursor from server response', () => {
		const store = __stream('pag/data', { merge: 'crud', key: 'id' });
		const values = [];
		const unsub = store.subscribe((v) => values.push(v));

		const sent = sendQueuedFn.mock.calls[0][0];
		simulateRpcResponse(sent.id, {
			ok: true,
			data: [{ id: 1 }],
			topic: 'pag-topic',
			merge: 'crud',
			key: 'id',
			hasMore: true,
			cursor: 'cur1'
		});

		expect(store.hasMore).toBe(true);
		expect(values[values.length - 1]).toEqual([{ id: 1 }]);

		unsub();
	});

	it('loadMore sends cursor and appends results', async () => {
		const store = __stream('pag/more', { merge: 'crud', key: 'id' });
		const values = [];
		const unsub = store.subscribe((v) => values.push(v));

		const sent = sendQueuedFn.mock.calls[0][0];
		simulateRpcResponse(sent.id, {
			ok: true,
			data: [{ id: 1 }],
			topic: 'pag-more-topic',
			merge: 'crud',
			key: 'id',
			hasMore: true,
			cursor: 'cur1'
		});

		// Call loadMore
		const morePromise = store.loadMore();

		// Should send a new request with cursor
		const moreSent = sendQueuedFn.mock.calls[1][0];
		expect(moreSent.cursor).toBe('cur1');
		expect(moreSent.stream).toBe(true);

		// Simulate server response for loadMore
		simulateRpcResponse(moreSent.id, {
			ok: true,
			data: [{ id: 2 }, { id: 3 }],
			hasMore: false,
			cursor: null
		});

		const hasMore = await morePromise;
		expect(hasMore).toBe(false);

		const lastValue = values[values.length - 1];
		expect(lastValue).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);

		unsub();
	});

	it('loadMore returns false when no cursor or hasMore', async () => {
		const store = __stream('pag/nocur', { merge: 'crud', key: 'id' });
		const unsub = store.subscribe(() => {});

		const sent = sendQueuedFn.mock.calls[0][0];
		simulateRpcResponse(sent.id, {
			ok: true,
			data: [{ id: 1 }],
			topic: 'pag-nocur-topic',
			merge: 'crud',
			key: 'id'
			// No hasMore or cursor
		});

		const result = await store.loadMore();
		expect(result).toBe(false);

		unsub();
	});
});

// -- Phase 22: Binary RPC (client) --------------------------------------------

describe('__binaryRpc()', () => {
	it('sends binary frame with header and payload', () => {
		const upload = __binaryRpc('upload/avatar');
		const buffer = new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0]).buffer;

		const promise = upload(buffer, 'photo.jpg');

		// Should have sent exactly one message
		expect(sendQueuedFn).toHaveBeenCalledTimes(1);

		// The frame should be an ArrayBuffer starting with 0x00
		const frame = sendQueuedFn.mock.calls[0][0];
		expect(frame).toBeInstanceOf(ArrayBuffer);
		const bytes = new Uint8Array(frame);
		expect(bytes[0]).toBe(0x00);
	});

	it('resolves when server responds', async () => {
		const upload = __binaryRpc('upload/test');
		const buffer = new Uint8Array([1, 2, 3]).buffer;

		const promise = upload(buffer);

		// Extract the correlation ID from the binary frame header
		const frame = sendQueuedFn.mock.calls[0][0];
		const bytes = new Uint8Array(frame);
		const headerLen = (bytes[1] << 8) | bytes[2];
		const headerJson = new TextDecoder().decode(frame.slice(3, 3 + headerLen));
		const header = JSON.parse(headerJson);

		simulateRpcResponse(header.id, { ok: true, data: { url: '/uploads/test.bin' } });

		const result = await promise;
		expect(result).toEqual({ url: '/uploads/test.bin' });
	});
});

// -- Phase 23: configure() ---------------------------------------------------

describe('configure()', () => {
	it('is a callable function', () => {
		expect(typeof configure).toBe('function');
	});

	it('onConnect fires on status open', () => {
		let connected = false;
		configure({ onConnect() { connected = true; } });

		// First status event is skipped (initial)
		// Second one should fire
		simulateStatus('open');

		expect(connected).toBe(true);
	});

	it('onDisconnect fires on status closed', () => {
		let disconnected = false;
		configure({ onDisconnect() { disconnected = true; } });

		simulateStatus('closed');

		expect(disconnected).toBe(true);
	});
});

// -- combine() ----------------------------------------------------------------

describe('combine()', () => {
	function makeStore(initial) {
		let value = initial;
		const subs = new Set();
		return {
			set(v) { value = v; for (const fn of subs) fn(v); },
			subscribe(fn) { subs.add(fn); fn(value); return () => subs.delete(fn); }
		};
	}

	it('combines two stores into one', () => {
		const a = makeStore(1);
		const b = makeStore(2);
		const combined = combine(a, b, (x, y) => x + y);
		let value;
		const unsub = combined.subscribe(v => { value = v; });
		expect(value).toBe(3);
		unsub();
	});

	it('updates when any source changes', () => {
		const a = makeStore(1);
		const b = makeStore(10);
		const combined = combine(a, b, (x, y) => x + y);
		let value;
		const unsub = combined.subscribe(v => { value = v; });
		expect(value).toBe(11);

		a.set(5);
		expect(value).toBe(15);

		b.set(20);
		expect(value).toBe(25);
		unsub();
	});

	it('handles undefined (loading) sources gracefully', () => {
		const a = makeStore(undefined);
		const b = makeStore(42);
		const combined = combine(a, b, (x, y) => ({ a: x, b: y }));
		let value;
		const unsub = combined.subscribe(v => { value = v; });
		expect(value).toEqual({ a: undefined, b: 42 });

		a.set([1, 2, 3]);
		expect(value).toEqual({ a: [1, 2, 3], b: 42 });
		unsub();
	});

	it('unsubscribes from all sources when last subscriber leaves', () => {
		const a = makeStore(1);
		const b = makeStore(2);
		const combined = combine(a, b, (x, y) => x + y);

		const unsub1 = combined.subscribe(() => {});
		const unsub2 = combined.subscribe(() => {});

		// Still subscribed, changes should propagate
		let value;
		unsub1();
		const unsub3 = combined.subscribe(v => { value = v; });
		a.set(10);
		expect(value).toBe(12);

		// Unsubscribe all
		unsub2();
		unsub3();

		// Sources should be cleaned up -- set should not throw
		a.set(100);
	});

	it('combines three or more stores', () => {
		const a = makeStore('hello');
		const b = makeStore(' ');
		const c = makeStore('world');
		const combined = combine(a, b, c, (x, y, z) => x + y + z);
		let value;
		const unsub = combined.subscribe(v => { value = v; });
		expect(value).toBe('hello world');
		unsub();
	});

	it('throws if fewer than 2 source stores', () => {
		const a = makeStore(1);
		expect(() => combine(a, (x) => x)).toThrow('at least 2 source stores');
	});

	it('throws if no combining function', () => {
		const a = makeStore(1);
		const b = makeStore(2);
		expect(() => combine(a, b)).toThrow('combining function');
	});

	it('resubscribing after full unsubscribe works', () => {
		const a = makeStore(1);
		const b = makeStore(2);
		const combined = combine(a, b, (x, y) => x * y);

		let value;
		const unsub = combined.subscribe(v => { value = v; });
		expect(value).toBe(2);
		unsub();

		// Re-subscribe should work with fresh state
		a.set(3);
		b.set(4);
		const unsub2 = combined.subscribe(v => { value = v; });
		expect(value).toBe(12);
		unsub2();
	});
});

// -- Undo/Redo (Phase 36) ----------------------------------------------------

describe('stream undo/redo', () => {
	it('canUndo is false before enableHistory', () => {
		const store = __stream('undo/test', { merge: 'crud', key: 'id' });
		expect(store.canUndo).toBe(false);
		expect(store.canRedo).toBe(false);
	});

	it('undo restores previous value after optimistic update', () => {
		const store = __stream('undo/test2', { merge: 'crud', key: 'id' });
		let value;
		const unsub = store.subscribe(v => { value = v; });

		const sent = sendQueuedFn.mock.calls[0][0];
		simulateRpcResponse(sent.id, {
			ok: true, data: [{ id: 1, text: 'a' }], topic: 'undo2', merge: 'crud', key: 'id'
		});

		store.enableHistory();
		expect(value).toEqual([{ id: 1, text: 'a' }]);

		store.optimistic('created', { id: 2, text: 'b' });
		expect(value).toEqual([{ id: 1, text: 'a' }, { id: 2, text: 'b' }]);
		expect(store.canUndo).toBe(true);

		store.undo();
		expect(value).toEqual([{ id: 1, text: 'a' }]);
		expect(store.canUndo).toBe(false);
		expect(store.canRedo).toBe(true);

		unsub();
	});

	it('redo re-applies after undo', () => {
		const store = __stream('undo/test3', { merge: 'crud', key: 'id' });
		let value;
		const unsub = store.subscribe(v => { value = v; });

		const sent = sendQueuedFn.mock.calls[0][0];
		simulateRpcResponse(sent.id, {
			ok: true, data: [{ id: 1 }], topic: 'undo3', merge: 'crud', key: 'id'
		});

		store.enableHistory();
		store.optimistic('created', { id: 2 });
		expect(value).toEqual([{ id: 1 }, { id: 2 }]);

		store.undo();
		expect(value).toEqual([{ id: 1 }]);

		store.redo();
		expect(value).toEqual([{ id: 1 }, { id: 2 }]);
		expect(store.canRedo).toBe(false);

		unsub();
	});

	it('new change after undo discards redo stack', () => {
		const store = __stream('undo/test4', { merge: 'crud', key: 'id' });
		let value;
		const unsub = store.subscribe(v => { value = v; });

		const sent = sendQueuedFn.mock.calls[0][0];
		simulateRpcResponse(sent.id, {
			ok: true, data: [], topic: 'undo4', merge: 'crud', key: 'id'
		});

		store.enableHistory();
		store.optimistic('created', { id: 1 });
		store.optimistic('created', { id: 2 });
		store.undo();
		expect(value).toEqual([{ id: 1 }]);

		// New change should discard the redo entry
		store.optimistic('created', { id: 3 });
		expect(store.canRedo).toBe(false);
		expect(value).toEqual([{ id: 1 }, { id: 3 }]);

		unsub();
	});

	it('history cap is enforced', () => {
		const store = __stream('undo/test5', { merge: 'set' });
		let value;
		const unsub = store.subscribe(v => { value = v; });

		const sent = sendQueuedFn.mock.calls[0][0];
		simulateRpcResponse(sent.id, {
			ok: true, data: 0, topic: 'undo5', merge: 'set'
		});

		store.enableHistory(3);

		// Push 5 changes, but cap is 3
		simulateTopicMessage('undo5', { event: 'set', data: 1 });
		simulateTopicMessage('undo5', { event: 'set', data: 2 });
		simulateTopicMessage('undo5', { event: 'set', data: 3 });
		simulateTopicMessage('undo5', { event: 'set', data: 4 });
		simulateTopicMessage('undo5', { event: 'set', data: 5 });

		expect(value).toBe(5);

		// Can undo at most cap-1 times (cap entries = cap-1 undos)
		store.undo(); expect(value).toBe(4);
		store.undo(); expect(value).toBe(3);
		expect(store.canUndo).toBe(false); // at the beginning of capped history

		unsub();
	});

	it('history is cleared on cleanup/unsubscribe', () => {
		const store = __stream('undo/test6', { merge: 'set' });
		let value;
		const unsub = store.subscribe(v => { value = v; });

		const sent = sendQueuedFn.mock.calls[0][0];
		simulateRpcResponse(sent.id, {
			ok: true, data: 'init', topic: 'undo6', merge: 'set'
		});

		store.enableHistory();
		simulateTopicMessage('undo6', { event: 'set', data: 'changed' });
		expect(store.canUndo).toBe(true);

		unsub();
		expect(store.canUndo).toBe(false);
	});
});

// -- onSignal() (Phase 43) ----------------------------------------------------

describe('onSignal()', () => {
	it('fires callback when a signal is received', () => {
		const calls = [];
		const unsub = onSignal((event, data) => {
			calls.push({ event, data });
		});

		simulateTopicMessage('__signal', { event: 'call:offer', data: { from: 'alice' } });

		expect(calls.length).toBe(1);
		expect(calls[0].event).toBe('call:offer');
		expect(calls[0].data).toEqual({ from: 'alice' });

		unsub();
	});

	it('receives multiple signals sequentially', () => {
		const calls = [];
		const unsub = onSignal((event, data) => calls.push(event));

		simulateTopicMessage('__signal', { event: 'ping', data: {} });
		simulateTopicMessage('__signal', { event: 'pong', data: {} });

		expect(calls).toEqual(['ping', 'pong']);

		unsub();
	});

	it('unsubscribe removes the handler', () => {
		const calls = [];
		const unsub = onSignal((event, data) => calls.push(event));
		unsub();

		simulateTopicMessage('__signal', { event: 'after-unsub', data: {} });
		expect(calls.length).toBe(0);
	});

	it('subscribes to user-specific signal topic when userId is provided', () => {
		const calls = [];
		const unsub = onSignal('user42', (event, data) => {
			calls.push({ event, data });
		});

		// Should NOT respond to generic signal
		simulateTopicMessage('__signal', { event: 'generic', data: {} });
		expect(calls.length).toBe(0);

		// Should respond to user-specific signal
		simulateTopicMessage('__signal:user42', { event: 'call:offer', data: { from: 'bob' } });
		expect(calls.length).toBe(1);
		expect(calls[0].event).toBe('call:offer');
		expect(calls[0].data).toEqual({ from: 'bob' });

		unsub();
	});

	it('legacy overload (callback only) still works', () => {
		const calls = [];
		const unsub = onSignal((event, data) => calls.push(event));

		simulateTopicMessage('__signal', { event: 'test', data: {} });
		expect(calls).toEqual(['test']);

		unsub();
	});
});

// -- .when() (Phase 40: gate) -------------------------------------------------

describe('.when(condition)', () => {
	it('.when(false) keeps store as undefined and makes no RPC call', () => {
		const store = __stream('gate/dormant', { merge: 'set' });
		const gated = store.when(false);
		const values = [];
		const unsub = gated.subscribe((v) => values.push(v));

		// No RPC should have been sent
		expect(sendQueuedFn).not.toHaveBeenCalled();
		expect(values).toEqual([undefined]);

		unsub();
	});

	it('.when(true) activates the stream normally', () => {
		const store = __stream('gate/active', { merge: 'set' });
		const gated = store.when(true);
		const values = [];
		const unsub = gated.subscribe((v) => values.push(v));

		// Should have sent the stream RPC
		expect(sendQueuedFn).toHaveBeenCalled();
		const sent = sendQueuedFn.mock.calls[0][0];
		expect(sent.rpc).toBe('gate/active');
		expect(sent.stream).toBe(true);

		// Simulate response
		simulateRpcResponse(sent.id, {
			ok: true, data: 'hello', topic: 'gate-t', merge: 'set'
		});

		expect(values[values.length - 1]).toBe('hello');

		unsub();
	});

	it('.when() with a store-like object reacts to changes', () => {
		let storeValue = false;
		const subscribers = new Set();
		const conditionStore = {
			subscribe(fn) {
				subscribers.add(fn);
				fn(storeValue);
				return () => subscribers.delete(fn);
			}
		};

		const store = __stream('gate/store', { merge: 'set' });
		const gated = store.when(conditionStore);
		const values = [];
		const unsub = gated.subscribe((v) => values.push(v));

		// Condition is false, stream should not activate
		expect(sendQueuedFn).not.toHaveBeenCalled();
		expect(values).toEqual([undefined]);

		// Set condition to true
		storeValue = true;
		for (const fn of subscribers) fn(true);

		// Now the stream should activate
		expect(sendQueuedFn).toHaveBeenCalled();
		const sent = sendQueuedFn.mock.calls[0][0];
		simulateRpcResponse(sent.id, {
			ok: true, data: 'activated', topic: 'gate-store-t', merge: 'set'
		});

		expect(values[values.length - 1]).toBe('activated');

		// Set condition back to false
		storeValue = false;
		for (const fn of subscribers) fn(false);

		// Should deactivate (value becomes undefined)
		expect(values[values.length - 1]).toBeUndefined();

		unsub();
	});

	it('.when() with a function evaluates on subscribe', () => {
		const store = __stream('gate/fn', { merge: 'set' });
		const gated = store.when(() => true);
		const values = [];
		const unsub = gated.subscribe((v) => values.push(v));

		// Function returned true, should activate
		expect(sendQueuedFn).toHaveBeenCalled();

		unsub();
	});

	it('unsubscribing from gated store cleans up underlying stream', () => {
		const store = __stream('gate/cleanup', { merge: 'set' });
		const gated = store.when(true);
		const values = [];
		const unsub = gated.subscribe((v) => values.push(v));

		const sent = sendQueuedFn.mock.calls[0][0];
		simulateRpcResponse(sent.id, {
			ok: true, data: 'data', topic: 'gate-cleanup-t', merge: 'set'
		});

		expect(values[values.length - 1]).toBe('data');
		unsub();

		// Resubscribe -- should get undefined (stream was cleaned up), and a new RPC sent
		const values2 = [];
		const unsub2 = gated.subscribe((v) => values2.push(v));
		expect(values2[0]).toBeUndefined();
		unsub2();
	});
});
