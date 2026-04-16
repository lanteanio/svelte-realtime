import { describe, it, expect, vi, beforeEach } from 'vitest';

let __rpc, __stream, __binaryRpc, RpcError, batch, configure, combine, onSignal, onDerived;
let topicCallbacks;
let statusCallbacks;
let sendQueuedFn;
let readyReject;
let connectFn;

/**
 * Simulate an RPC response arriving from the server.
 */
function simulateRpcResponse(correlationId, payload) {
	const fns = topicCallbacks.get('__rpc');
	if (fns) for (const cb of fns) cb({ event: correlationId, data: payload });
}

/**
 * Simulate a pub/sub message on a topic.
 */
function simulateTopicMessage(topic, envelope) {
	const fns = topicCallbacks.get(topic);
	if (fns) for (const cb of fns) cb(envelope);
}

/**
 * Simulate a connection status change.
 */
function simulateStatus(s) {
	for (const cb of statusCallbacks) cb(s);
}

/**
 * Wait one microtask. Needed after stream subscribe() because stream RPCs
 * are now batched within a microtask via _batchedSubscribe.
 */
function flush() {
	return new Promise((r) => queueMicrotask(r));
}

beforeEach(async () => {
	vi.resetModules();

	topicCallbacks = new Map();
	statusCallbacks = new Set();
	sendQueuedFn = vi.fn();

	connectFn = vi.fn(() => ({
		sendQueued: sendQueuedFn,
		ready: () => new Promise((_resolve, reject) => { readyReject = reject; })
	}));

	vi.doMock('svelte-adapter-uws/client', () => ({
		connect: connectFn,
		on: (topic) => ({
			subscribe: (fn) => {
				let fns = topicCallbacks.get(topic);
				if (!fns) { fns = new Set(); topicCallbacks.set(topic, fns); }
				fns.add(fn);
				return () => {
					fns.delete(fn);
					if (fns.size === 0) topicCallbacks.delete(topic);
				};
			}
		}),
		onDerived: (topicFn, store) => {
			let currentTopic = null;
			let unsub = null;
			const subs = new Set();
			const derivedStore = {
				subscribe(fn) {
					subs.add(fn);
					fn(null);
					if (!unsub) {
						unsub = store.subscribe((val) => {
							currentTopic = topicFn(val);
						});
					}
					return () => {
						subs.delete(fn);
						if (subs.size === 0 && unsub) { unsub(); unsub = null; }
					};
				},
				_getCurrentTopic() { return currentTopic; }
			};
			return derivedStore;
		},
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
		},
		readable: (initial) => {
			const subs = new Set();
			return {
				subscribe(fn) { subs.add(fn); fn(initial); return () => subs.delete(fn); }
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
	onDerived = mod.onDerived;
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
	it('resolves with full response (topic + data) for stream requests', async () => {
		const store = __stream('chat/messages', { merge: 'crud', key: 'id' });
		const values = [];
		const unsub = store.subscribe((v) => values.push(v));

		// Extract the sent message to get the correlation ID
		await flush();
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

	it('receives live updates after initial load', async () => {
		const store = __stream('items/list', { merge: 'crud', key: 'id' });
		const values = [];
		const unsub = store.subscribe((v) => values.push(v));

		await flush();
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

	it('uses server-provided options over build-time defaults (Finding 5)', async () => {
		// Build-time says merge:'crud' key:'id', server overrides with key:'uid'
		const store = __stream('users/list', { merge: 'crud', key: 'id' });
		const values = [];
		const unsub = store.subscribe((v) => values.push(v));

		await flush();
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

	it('latest merge pushes raw data, not envelopes (Finding 4)', async () => {
		const store = __stream('activity/feed', { merge: 'latest', max: 10 });
		const values = [];
		const unsub = store.subscribe((v) => values.push(v));

		await flush();
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

	it('cleanup removes pending entry from shared map (Finding 3)', async () => {
		const store = __stream('temp/data', { merge: 'set' });
		const unsub = store.subscribe(() => {});

		// There should be a pending entry (the stream fetch)
		await flush();
		const sent = sendQueuedFn.mock.calls[0][0];
		expect(sent.stream).toBe(true);

		// Unsubscribe before the server responds - cleanup should remove pending
		unsub();
		await new Promise((r) => queueMicrotask(r)); // Wait for deferred cleanup

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
		const errors = [];
		const unsub = store.subscribe((v) => values.push(v));
		store.error.subscribe((v) => errors.push(v));

		await flush();
		const firstSent = sendQueuedFn.mock.calls[0][0];

		// Disconnect before the initial load completes
		simulateStatus('closed');

		// The disconnect listener rejects pending entries
		// Data store stays undefined, error is on .error store
		const afterDisconnect = values[values.length - 1];
		expect(afterDisconnect).toBeUndefined();
		expect(errors[errors.length - 1]).not.toBe(null);
		expect(errors[errors.length - 1].code).toBe('DISCONNECTED');

		// Reconnect (debounced with jitter -- wait for it)
		simulateStatus('open');
		await new Promise((r) => setTimeout(r, 250));

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
	it('optimistic created immediately adds item to store', async () => {
		const store = __stream('opt/items', { merge: 'crud', key: 'id' });
		const values = [];
		const unsub = store.subscribe((v) => values.push(v));

		await flush();
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

	it('server event with same key replaces optimistic entry (no duplicate)', async () => {
		const store = __stream('opt/dedup', { merge: 'crud', key: 'id' });
		const values = [];
		const unsub = store.subscribe((v) => values.push(v));

		await flush();
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

	it('optimistic set replaces value, rollback restores', async () => {
		const store = __stream('opt/set', { merge: 'set' });
		const values = [];
		const unsub = store.subscribe((v) => values.push(v));

		await flush();
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

	it('optimistic updated snapshots previous, rollback restores', async () => {
		const store = __stream('opt/upd', { merge: 'crud', key: 'id' });
		const values = [];
		const unsub = store.subscribe((v) => values.push(v));

		await flush();
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

	it('sends args in the stream request', async () => {
		const factory = __stream('rooms/withargs', { merge: 'crud', key: 'id' }, true);
		const store = factory('room-42');
		const unsub = store.subscribe(() => {});

		await flush();
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
		simulateTopicMessage('__rpc', {
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

		simulateTopicMessage('__rpc', {
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
	it('join adds to presence list', async () => {
		const store = __stream('room/presence', { merge: 'presence' });
		const values = [];
		const unsub = store.subscribe((v) => values.push(v));

		await flush();
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

	it('join with existing key updates in place', async () => {
		const store = __stream('room/upd', { merge: 'presence' });
		const values = [];
		const unsub = store.subscribe((v) => values.push(v));

		await flush();
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

	it('leave removes from presence list', async () => {
		const store = __stream('room/leave', { merge: 'presence' });
		const values = [];
		const unsub = store.subscribe((v) => values.push(v));

		await flush();
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

	it('set replaces entire presence list', async () => {
		const store = __stream('room/set', { merge: 'presence' });
		const values = [];
		const unsub = store.subscribe((v) => values.push(v));

		await flush();
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
	it('update adds or replaces cursor entry', async () => {
		const store = __stream('doc/cursors', { merge: 'cursor' });
		const values = [];
		const unsub = store.subscribe((v) => values.push(v));

		await flush();
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

	it('remove deletes cursor entry', async () => {
		const store = __stream('doc/rm', { merge: 'cursor' });
		const values = [];
		const unsub = store.subscribe((v) => values.push(v));

		await flush();
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

	it('set replaces all cursors', async () => {
		const store = __stream('doc/cset', { merge: 'cursor' });
		const values = [];
		const unsub = store.subscribe((v) => values.push(v));

		await flush();
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

// -- __stream() hydrate + reconnect ------------------------------------------

describe('__stream() hydrate reconnect', () => {
	it('channel keeps hydrated data instead of overwriting with empty placeholder', async () => {
		const store = __stream('hydrate/presence', { merge: 'presence' });
		store.hydrate([{ key: 'u1', name: 'Alice' }]);

		const values = [];
		const unsub = store.subscribe((v) => values.push(v));

		await flush();
		const sent = sendQueuedFn.mock.calls[0][0];

		// Server responds with empty channel placeholder (channel: true)
		simulateRpcResponse(sent.id, {
			ok: true,
			data: [],
			topic: 'hydrate-presence',
			merge: 'presence',
			channel: true
		});

		// Store should still have the hydrated data, not []
		const last = values[values.length - 1];
		expect(last).toEqual([{ key: 'u1', name: 'Alice' }]);

		unsub();
	});

	it('channel keeps hydrated data on WebSocket reconnect', async () => {
		const store = __stream('hydrate/cursors', { merge: 'cursor', key: 'userId' });
		store.hydrate([{ userId: 'u1', x: 10, y: 20 }]);

		const values = [];
		const unsub = store.subscribe((v) => values.push(v));

		await flush();
		const sent1 = sendQueuedFn.mock.calls[0][0];
		simulateRpcResponse(sent1.id, {
			ok: true,
			data: [],
			topic: 'hydrate-cursors',
			merge: 'cursor',
			key: 'userId',
			channel: true
		});

		// Hydrated value should persist
		expect(values[values.length - 1]).toEqual([{ userId: 'u1', x: 10, y: 20 }]);

		// Disconnect and reconnect
		simulateStatus('closed');
		simulateStatus('open');
		await new Promise((r) => setTimeout(r, 250));

		const sent2 = sendQueuedFn.mock.calls[sendQueuedFn.mock.calls.length - 1][0];
		simulateRpcResponse(sent2.id, {
			ok: true,
			data: [],
			topic: 'hydrate-cursors',
			merge: 'cursor',
			key: 'userId',
			channel: true
		});

		// Still the hydrated data, not empty
		expect(values[values.length - 1]).toEqual([{ userId: 'u1', x: 10, y: 20 }]);

		unsub();
	});

	it('channel applies live events on top of hydrated data', async () => {
		const store = __stream('hydrate/live', { merge: 'presence' });
		store.hydrate([{ key: 'u1', name: 'Alice' }]);

		const values = [];
		const unsub = store.subscribe((v) => values.push(v));

		await flush();
		const sent = sendQueuedFn.mock.calls[0][0];
		simulateRpcResponse(sent.id, {
			ok: true,
			data: [],
			topic: 'hydrate-live',
			merge: 'presence',
			channel: true
		});

		// Live event arrives on top of hydrated data
		simulateTopicMessage('hydrate-live', { event: 'join', data: { key: 'u2', name: 'Bob' } });

		const last = values[values.length - 1];
		expect(last).toEqual([{ key: 'u1', name: 'Alice' }, { key: 'u2', name: 'Bob' }]);

		unsub();
	});

	it('set-merge channel keeps hydrated value instead of null', async () => {
		const store = __stream('hydrate/status', { merge: 'set' });
		store.hydrate({ online: 5, queued: 12 });

		const values = [];
		const unsub = store.subscribe((v) => values.push(v));

		await flush();
		const sent = sendQueuedFn.mock.calls[0][0];
		simulateRpcResponse(sent.id, {
			ok: true,
			data: null,
			topic: 'hydrate-status',
			merge: 'set',
			channel: true
		});

		// Should keep hydrated data, not null
		expect(values[values.length - 1]).toEqual({ online: 5, queued: 12 });

		unsub();
	});

	it('non-channel stream still updates with fresh loader data on reconnect', async () => {
		const store = __stream('hydrate/stats', { merge: 'set' });
		store.hydrate({ count: 100 });

		const values = [];
		const unsub = store.subscribe((v) => values.push(v));

		await flush();
		const sent1 = sendQueuedFn.mock.calls[0][0];
		simulateRpcResponse(sent1.id, {
			ok: true,
			data: { count: 105 },
			topic: 'hydrate-stats',
			merge: 'set'
		});

		// Fresh loader data replaces hydrated data
		expect(values[values.length - 1]).toEqual({ count: 105 });

		// Disconnect and reconnect
		simulateStatus('closed');
		simulateStatus('open');
		await new Promise((r) => setTimeout(r, 250));

		const sent2 = sendQueuedFn.mock.calls[sendQueuedFn.mock.calls.length - 1][0];
		simulateRpcResponse(sent2.id, {
			ok: true,
			data: { count: 110 },
			topic: 'hydrate-stats',
			merge: 'set'
		});

		// Updated again with latest loader data
		expect(values[values.length - 1]).toEqual({ count: 110 });

		unsub();
	});

	it('non-hydrated channel still starts with empty data', async () => {
		const store = __stream('noh/presence', { merge: 'presence' });

		const values = [];
		const unsub = store.subscribe((v) => values.push(v));

		await flush();
		const sent = sendQueuedFn.mock.calls[0][0];
		simulateRpcResponse(sent.id, {
			ok: true,
			data: [],
			topic: 'noh-presence',
			merge: 'presence',
			channel: true
		});

		// No hydration, so the empty placeholder is used
		expect(values[values.length - 1]).toEqual([]);

		unsub();
	});
});

// -- __stream() hydrate derived -----------------------------------------------

describe('__stream() hydrate derived', () => {
	it('keeps hydrated data when server returns stale derived result', async () => {
		const store = __stream('hydrate/derived-stats', { merge: 'set' });
		store.hydrate({ members: 42, audits: 566, emails: 57 });

		const values = [];
		const unsub = store.subscribe((v) => values.push(v));

		await flush();
		const sent = sendQueuedFn.mock.calls[0][0];

		simulateRpcResponse(sent.id, {
			ok: true,
			data: { members: 0, audits: 0, emails: 0 },
			topic: 'derived-stats',
			merge: 'set',
			derived: true
		});

		expect(values[values.length - 1]).toEqual({ members: 42, audits: 566, emails: 57 });

		unsub();
	});

	it('accepts live updates after initial hydration protection', async () => {
		const store = __stream('hydrate/derived-live', { merge: 'set' });
		store.hydrate({ count: 100 });

		const values = [];
		const unsub = store.subscribe((v) => values.push(v));

		await flush();
		const sent = sendQueuedFn.mock.calls[0][0];

		simulateRpcResponse(sent.id, {
			ok: true,
			data: { count: 0 },
			topic: 'derived-live',
			merge: 'set',
			derived: true
		});

		expect(values[values.length - 1]).toEqual({ count: 100 });

		simulateTopicMessage('derived-live', { event: 'set', data: { count: 120 } });

		expect(values[values.length - 1]).toEqual({ count: 120 });

		unsub();
	});

	it('keeps hydrated data on reconnect too since server marks derived responses', async () => {
		const store = __stream('hydrate/derived-reconn', { merge: 'set' });
		store.hydrate({ total: 50 });

		const values = [];
		const unsub = store.subscribe((v) => values.push(v));

		await flush();
		const sent1 = sendQueuedFn.mock.calls[0][0];

		simulateRpcResponse(sent1.id, {
			ok: true,
			data: { total: 0 },
			topic: 'derived-reconn',
			merge: 'set',
			derived: true
		});

		expect(values[values.length - 1]).toEqual({ total: 50 });

		// Live update brings real data
		simulateTopicMessage('derived-reconn', { event: 'set', data: { total: 75 } });

		expect(values[values.length - 1]).toEqual({ total: 75 });

		// Reconnect
		simulateStatus('closed');
		simulateStatus('open');
		await new Promise((r) => setTimeout(r, 250));

		const sent2 = sendQueuedFn.mock.calls[sendQueuedFn.mock.calls.length - 1][0];

		// Reconnect response also has derived: true, keeps current value (75)
		simulateRpcResponse(sent2.id, {
			ok: true,
			data: { total: 0 },
			topic: 'derived-reconn',
			merge: 'set',
			derived: true
		});

		expect(values[values.length - 1]).toEqual({ total: 75 });

		unsub();
	});

	it('crud-merge derived keeps hydrated array', async () => {
		const store = __stream('hydrate/derived-crud', { merge: 'crud', key: 'id' });
		store.hydrate([{ id: 1, name: 'Alice' }, { id: 2, name: 'Bob' }]);

		const values = [];
		const unsub = store.subscribe((v) => values.push(v));

		await flush();
		const sent = sendQueuedFn.mock.calls[0][0];

		simulateRpcResponse(sent.id, {
			ok: true,
			data: [],
			topic: 'derived-crud',
			merge: 'crud',
			key: 'id',
			derived: true
		});

		expect(values[values.length - 1]).toEqual([{ id: 1, name: 'Alice' }, { id: 2, name: 'Bob' }]);

		unsub();
	});

	it('non-hydrated derived stream still receives server data', async () => {
		const store = __stream('no-hydrate/derived', { merge: 'set' });

		const values = [];
		const unsub = store.subscribe((v) => values.push(v));

		await flush();
		const sent = sendQueuedFn.mock.calls[0][0];

		simulateRpcResponse(sent.id, {
			ok: true,
			data: { count: 42 },
			topic: 'no-hydrate-derived',
			merge: 'set',
			derived: true
		});

		// No hydration, so currentValue is undefined -- derived protection does not apply
		expect(values[values.length - 1]).toEqual({ count: 42 });

		unsub();
	});
});

// -- __stream() seq tracking (Phase 15) ---------------------------------------

describe('__stream() seq tracking', () => {
	it('sends seq on reconnect request', async () => {
		const store = __stream('seq/data', { merge: 'crud', key: 'id' });
		const values = [];
		const unsub = store.subscribe((v) => values.push(v));

		await flush();
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

		// Disconnect and reconnect (debounced with jitter -- wait for it)
		simulateStatus('closed');
		simulateStatus('open');
		await new Promise((r) => setTimeout(r, 250));

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
	it('tracks hasMore and cursor from server response', async () => {
		const store = __stream('pag/data', { merge: 'crud', key: 'id' });
		const values = [];
		const unsub = store.subscribe((v) => values.push(v));

		await flush();
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

		await flush();
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

		await flush();
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

	it('passes url to connect() for cross-origin usage', () => {
		connectFn.mockClear();
		configure({ url: 'wss://api.example.com/ws' });

		expect(connectFn).toHaveBeenCalledWith({ url: 'wss://api.example.com/ws' });
	});

	it('does not call connect() with url when url is not set', () => {
		connectFn.mockClear();
		configure({ onConnect() {} });

		const urlCalls = connectFn.mock.calls.filter(c => c[0]?.url);
		expect(urlCalls).toHaveLength(0);
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

	it('undo restores previous value after optimistic update', async () => {
		const store = __stream('undo/test2', { merge: 'crud', key: 'id' });
		let value;
		const unsub = store.subscribe(v => { value = v; });

		await flush();
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

	it('redo re-applies after undo', async () => {
		const store = __stream('undo/test3', { merge: 'crud', key: 'id' });
		let value;
		const unsub = store.subscribe(v => { value = v; });

		await flush();
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

	it('new change after undo discards redo stack', async () => {
		const store = __stream('undo/test4', { merge: 'crud', key: 'id' });
		let value;
		const unsub = store.subscribe(v => { value = v; });

		await flush();
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

	it('history cap is enforced', async () => {
		const store = __stream('undo/test5', { merge: 'set' });
		let value;
		const unsub = store.subscribe(v => { value = v; });

		await flush();
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

	it('history is cleared on cleanup/unsubscribe', async () => {
		const store = __stream('undo/test6', { merge: 'set' });
		let value;
		const unsub = store.subscribe(v => { value = v; });

		await flush();
		const sent = sendQueuedFn.mock.calls[0][0];
		simulateRpcResponse(sent.id, {
			ok: true, data: 'init', topic: 'undo6', merge: 'set'
		});

		store.enableHistory();
		simulateTopicMessage('undo6', { event: 'set', data: 'changed' });
		expect(store.canUndo).toBe(true);

		unsub();
		await new Promise((r) => queueMicrotask(r)); // Wait for deferred cleanup
		expect(store.canUndo).toBe(false);
	});
});

// -- pauseHistory / resumeHistory (Phase 36) ----------------------------------

describe('stream pauseHistory / resumeHistory', () => {
	it('pauseHistory suppresses undo snapshots while events still apply', async () => {
		const store = __stream('pause/test1', { merge: 'crud', key: 'id' });
		let value;
		const unsub = store.subscribe(v => { value = v; });

		await flush();
		const sent = sendQueuedFn.mock.calls[0][0];
		simulateRpcResponse(sent.id, {
			ok: true, data: [{ id: 1, text: 'a' }], topic: 'pause1', merge: 'crud', key: 'id'
		});

		store.enableHistory();
		store.pauseHistory();

		// Events still apply to the store value
		simulateTopicMessage('pause1', { event: 'created', data: { id: 2, text: 'b' } });
		expect(value).toEqual([{ id: 1, text: 'a' }, { id: 2, text: 'b' }]);

		// But undo should not be available (no snapshots recorded)
		expect(store.canUndo).toBe(false);

		unsub();
	});

	it('resumeHistory records a snapshot so undo goes back to resume-time state', async () => {
		const store = __stream('pause/test2', { merge: 'set' });
		let value;
		const unsub = store.subscribe(v => { value = v; });

		await flush();
		const sent = sendQueuedFn.mock.calls[0][0];
		simulateRpcResponse(sent.id, {
			ok: true, data: 0, topic: 'pause2', merge: 'set'
		});

		store.enableHistory();

		// Record one change before pausing
		simulateTopicMessage('pause2', { event: 'set', data: 1 });
		expect(store.canUndo).toBe(true);

		store.pauseHistory();

		// Several changes while paused — no snapshots
		simulateTopicMessage('pause2', { event: 'set', data: 2 });
		simulateTopicMessage('pause2', { event: 'set', data: 3 });
		expect(value).toBe(3);

		store.resumeHistory();

		// One more change after resume
		simulateTopicMessage('pause2', { event: 'set', data: 4 });
		expect(value).toBe(4);

		// Undo should go back to the resume-time snapshot (3), not 2 or 1
		store.undo();
		expect(value).toBe(3);

		unsub();
	});

	it('resumeHistory is a no-op when not paused', async () => {
		const store = __stream('pause/test3', { merge: 'set' });
		let value;
		const unsub = store.subscribe(v => { value = v; });

		await flush();
		const sent = sendQueuedFn.mock.calls[0][0];
		simulateRpcResponse(sent.id, {
			ok: true, data: 'init', topic: 'pause3', merge: 'set'
		});

		store.enableHistory();
		simulateTopicMessage('pause3', { event: 'set', data: 'changed' });

		// Resume without pause should not create an extra snapshot
		store.resumeHistory();

		store.undo();
		expect(value).toBe('init');
		// No further undo available
		expect(store.canUndo).toBe(false);

		unsub();
	});

	it('optimistic updates during pause do not create undo entries', async () => {
		const store = __stream('pause/test4', { merge: 'crud', key: 'id' });
		let value;
		const unsub = store.subscribe(v => { value = v; });

		await flush();
		const sent = sendQueuedFn.mock.calls[0][0];
		simulateRpcResponse(sent.id, {
			ok: true, data: [{ id: 1 }], topic: 'pause4', merge: 'crud', key: 'id'
		});

		store.enableHistory();
		store.pauseHistory();

		store.optimistic('created', { id: 2 });
		expect(value).toEqual([{ id: 1 }, { id: 2 }]);
		expect(store.canUndo).toBe(false);

		store.resumeHistory();

		// After resume, new changes should record history again
		store.optimistic('created', { id: 3 });
		expect(store.canUndo).toBe(true);

		store.undo();
		expect(value).toEqual([{ id: 1 }, { id: 2 }]);

		unsub();
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

	it('.when(true) activates the stream normally', async () => {
		const store = __stream('gate/active', { merge: 'set' });
		const gated = store.when(true);
		const values = [];
		const unsub = gated.subscribe((v) => values.push(v));

		// Should have sent the stream RPC
		await flush();
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

	it('.when() with a store-like object reacts to changes', async () => {
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
		await flush();
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

	it('.when() with a function evaluates on subscribe', async () => {
		const store = __stream('gate/fn', { merge: 'set' });
		const gated = store.when(() => true);
		const values = [];
		const unsub = gated.subscribe((v) => values.push(v));

		// Function returned true, should activate
		await flush();
		expect(sendQueuedFn).toHaveBeenCalled();

		unsub();
	});

	it('unsubscribing from gated store cleans up underlying stream', async () => {
		const store = __stream('gate/cleanup', { merge: 'set' });
		const gated = store.when(true);
		const values = [];
		const unsub = gated.subscribe((v) => values.push(v));

		await flush();
		const sent = sendQueuedFn.mock.calls[0][0];
		simulateRpcResponse(sent.id, {
			ok: true, data: 'data', topic: 'gate-cleanup-t', merge: 'set'
		});

		expect(values[values.length - 1]).toBe('data');
		unsub();
		await new Promise((r) => queueMicrotask(r)); // Wait for deferred cleanup

		// Resubscribe -- should get undefined (stream was cleaned up), and a new RPC sent
		const values2 = [];
		const unsub2 = gated.subscribe((v) => values2.push(v));
		expect(values2[0]).toBeUndefined();
		unsub2();
	});
});

// -- dedup key collision (null vs 'null') -------------------------------------

describe('__rpc() dedup key collision', () => {
	it('null and string "null" are separate calls', async () => {
		const call = __rpc('dedup/test');

		const p1 = call(null);
		const p2 = call('null');

		// Should send two separate messages (not deduped)
		expect(sendQueuedFn).toHaveBeenCalledTimes(2);

		const sent1 = sendQueuedFn.mock.calls[0][0];
		const sent2 = sendQueuedFn.mock.calls[1][0];
		expect(sent1.id).not.toBe(sent2.id);

		simulateRpcResponse(sent1.id, { ok: true, data: 'from-null' });
		simulateRpcResponse(sent2.id, { ok: true, data: 'from-string' });

		expect(await p1).toBe('from-null');
		expect(await p2).toBe('from-string');
	});

	it('number 0 and string "0" are separate calls', async () => {
		const call = __rpc('dedup/types');

		const p1 = call(0);
		const p2 = call('0');

		expect(sendQueuedFn).toHaveBeenCalledTimes(2);

		const sent1 = sendQueuedFn.mock.calls[0][0];
		const sent2 = sendQueuedFn.mock.calls[1][0];

		simulateRpcResponse(sent1.id, { ok: true, data: 'number' });
		simulateRpcResponse(sent2.id, { ok: true, data: 'string' });

		expect(await p1).toBe('number');
		expect(await p2).toBe('string');
	});

	it('identical calls within microtask still dedup', async () => {
		const call = __rpc('dedup/same');

		const p1 = call('hello');
		const p2 = call('hello');

		// Should send only one message
		expect(sendQueuedFn).toHaveBeenCalledTimes(1);
		expect(p1).toBe(p2);

		const sent = sendQueuedFn.mock.calls[0][0];
		simulateRpcResponse(sent.id, { ok: true, data: 'result' });
		expect(await p1).toBe('result');
	});
});

// -- CRUD delete swap-remove --------------------------------------------------

describe('__stream() CRUD delete swap-remove', () => {
	it('delete from middle removes item without affecting others', async () => {
		const store = __stream('swap/items', { merge: 'crud', key: 'id' });
		const values = [];
		const unsub = store.subscribe((v) => values.push(v));

		await flush();
		const sent = sendQueuedFn.mock.calls[0][0];
		simulateRpcResponse(sent.id, {
			ok: true,
			data: [{ id: 1, n: 'A' }, { id: 2, n: 'B' }, { id: 3, n: 'C' }, { id: 4, n: 'D' }],
			topic: 'swap-items',
			merge: 'crud',
			key: 'id'
		});

		// Delete from the middle (id: 2)
		simulateTopicMessage('swap-items', { event: 'deleted', data: { id: 2 } });

		const last = values[values.length - 1];
		expect(last).toHaveLength(3);
		expect(last.map(i => i.id).sort()).toEqual([1, 3, 4]);

		// Subsequent updates to remaining items should still work via the index
		simulateTopicMessage('swap-items', { event: 'updated', data: { id: 3, n: 'C2' } });
		const updated = values[values.length - 1];
		const item3 = updated.find(i => i.id === 3);
		expect(item3.n).toBe('C2');

		unsub();
	});

	it('delete last item works (no swap needed)', async () => {
		const store = __stream('swap/last', { merge: 'crud', key: 'id' });
		const values = [];
		const unsub = store.subscribe((v) => values.push(v));

		await flush();
		const sent = sendQueuedFn.mock.calls[0][0];
		simulateRpcResponse(sent.id, {
			ok: true,
			data: [{ id: 1 }, { id: 2 }],
			topic: 'swap-last',
			merge: 'crud',
			key: 'id'
		});

		simulateTopicMessage('swap-last', { event: 'deleted', data: { id: 2 } });

		const last = values[values.length - 1];
		expect(last).toEqual([{ id: 1 }]);

		unsub();
	});

	it('create after delete reuses freed slot correctly', async () => {
		const store = __stream('swap/reuse', { merge: 'crud', key: 'id' });
		const values = [];
		const unsub = store.subscribe((v) => values.push(v));

		await flush();
		const sent = sendQueuedFn.mock.calls[0][0];
		simulateRpcResponse(sent.id, {
			ok: true,
			data: [{ id: 1 }, { id: 2 }, { id: 3 }],
			topic: 'swap-reuse',
			merge: 'crud',
			key: 'id'
		});

		// Delete id: 1 (first), then create id: 5
		simulateTopicMessage('swap-reuse', { event: 'deleted', data: { id: 1 } });
		simulateTopicMessage('swap-reuse', { event: 'created', data: { id: 5 } });

		const last = values[values.length - 1];
		expect(last).toHaveLength(3);
		expect(last.map(i => i.id).sort()).toEqual([2, 3, 5]);

		unsub();
	});
});

// -- Terminated preflight on binary/batch/stream ------------------------------

describe('terminated preflight', () => {
	it('binary RPC rejects immediately when terminated', async () => {
		// Trigger an RPC first to ensure the disconnect listener is attached
		const warmup = __rpc('warmup/path');
		const warmupPromise = warmup('test').catch(() => {});
		await flush();

		// Terminate the connection via ready() rejection
		readyReject(new Error('Connection permanently closed'));
		await new Promise((r) => setTimeout(r, 10));

		const binaryCall = __binaryRpc('upload/file');
		await expect(binaryCall(new ArrayBuffer(4))).rejects.toMatchObject({
			code: 'CONNECTION_CLOSED'
		});
	});

	it('batch rejects immediately when terminated', async () => {
		// Trigger an RPC first to ensure the disconnect listener is attached
		const warmup = __rpc('warmup/batch');
		const warmupPromise = warmup('test').catch(() => {});
		await flush();

		// Terminate the connection via ready() rejection
		readyReject(new Error('Connection permanently closed'));
		await new Promise((r) => setTimeout(r, 10));

		const rpc = __rpc('test/fn');
		await expect(
			batch(() => [rpc('a')])
		).rejects.toMatchObject({
			code: 'CONNECTION_CLOSED'
		});
	});
});

// -- Multi-listener topic delivery --------------------------------------------

describe('multi-listener topic delivery', () => {
	it('delivers events to two independent subscribers on the same topic', async () => {
		const store1 = __stream('multi/a', { merge: 'set' });
		const store2 = __stream('multi/b', { merge: 'set' });
		const values1 = [];
		const values2 = [];
		const unsub1 = store1.subscribe((v) => values1.push(v));
		const unsub2 = store2.subscribe((v) => values2.push(v));

		await flush();

		// Both streams subscribe via batched RPCs; respond to each
		const calls = sendQueuedFn.mock.calls;
		for (const call of calls) {
			const msg = call[0];
			if (msg.rpc === 'multi/a') {
				simulateRpcResponse(msg.id, {
					ok: true, data: 'init-a', topic: 'shared-topic', merge: 'set'
				});
			}
			if (msg.rpc === 'multi/b') {
				simulateRpcResponse(msg.id, {
					ok: true, data: 'init-b', topic: 'shared-topic', merge: 'set'
				});
			}
			// Handle batch frames
			if (msg.batch) {
				for (const item of msg.batch) {
					if (item.rpc === 'multi/a') {
						simulateRpcResponse(item.id, {
							ok: true, data: 'init-a', topic: 'shared-topic', merge: 'set'
						});
					}
					if (item.rpc === 'multi/b') {
						simulateRpcResponse(item.id, {
							ok: true, data: 'init-b', topic: 'shared-topic', merge: 'set'
						});
					}
				}
			}
		}

		// Publish on the shared topic -- both listeners should receive it
		simulateTopicMessage('shared-topic', { event: 'set', data: 'broadcast' });

		const last1 = values1[values1.length - 1];
		const last2 = values2[values2.length - 1];
		expect(last1).toBe('broadcast');
		expect(last2).toBe('broadcast');

		unsub1();
		unsub2();
	});
});

// -- Batch response for stream subscribes (regression test) -------------------

describe('batched stream subscribe responses', () => {
	it('delivers initial data and events when streams are batched (set + latest)', async () => {
		const settingsStore = __stream('board/settings', { merge: 'set' });
		const activityStore = __stream('board/activity', { merge: 'latest', max: 30 });
		const settingsValues = [];
		const activityValues = [];
		const unsub1 = settingsStore.subscribe((v) => settingsValues.push(v));
		const unsub2 = activityStore.subscribe((v) => activityValues.push(v));

		await flush();

		// Both streams are sent as a single batch frame
		const sent = sendQueuedFn.mock.calls[0][0];
		expect(sent.batch).toHaveLength(2);

		// Server responds with a batch response (the __batch path)
		simulateTopicMessage('__rpc', {
			event: '__batch',
			data: {
				batch: [
					{ id: sent.batch[0].id, ok: true, data: { title: 'My Board' }, topic: 'settings:123', merge: 'set' },
					{ id: sent.batch[1].id, ok: true, data: [], topic: 'activity:123', merge: 'latest', max: 30 }
				]
			}
		});

		// Initial data should be delivered
		expect(settingsValues[settingsValues.length - 1]).toEqual({ title: 'My Board' });
		expect(activityValues[activityValues.length - 1]).toEqual([]);

		// Published events should be received
		simulateTopicMessage('settings:123', { event: 'set', data: { title: 'Renamed' } });
		expect(settingsValues[settingsValues.length - 1]).toEqual({ title: 'Renamed' });

		simulateTopicMessage('activity:123', { event: 'action', data: { type: 'renamed', user: 'Alice' } });
		expect(activityValues[activityValues.length - 1]).toEqual([{ type: 'renamed', user: 'Alice' }]);

		unsub1();
		unsub2();
	});
});

// -- onDerived re-export ------------------------------------------------------

describe('onDerived()', () => {
	it('is re-exported from the adapter client', () => {
		expect(typeof onDerived).toBe('function');
	});

	it('returns a subscribable store that tracks the source store topic', () => {
		const sourceSubs = new Set();
		const sourceStore = {
			subscribe(fn) { sourceSubs.add(fn); fn('room-42'); return () => sourceSubs.delete(fn); }
		};

		const derived = onDerived((id) => `chat:${id}`, sourceStore);
		expect(typeof derived.subscribe).toBe('function');

		const values = [];
		const unsub = derived.subscribe((v) => values.push(v));
		expect(values).toContain(null);
		expect(derived._getCurrentTopic()).toBe('chat:room-42');
		unsub();
	});

	it('switches topic when source store value changes', () => {
		const sourceSubs = new Set();
		let currentVal = 'a';
		const sourceStore = {
			subscribe(fn) {
				sourceSubs.add(fn);
				fn(currentVal);
				return () => sourceSubs.delete(fn);
			}
		};

		const derived = onDerived((id) => `room:${id}`, sourceStore);
		const unsub = derived.subscribe(() => {});
		expect(derived._getCurrentTopic()).toBe('room:a');

		currentVal = 'b';
		for (const fn of sourceSubs) fn('b');
		expect(derived._getCurrentTopic()).toBe('room:b');
		unsub();
	});
});

// -- CRUD max trimming --------------------------------------------------------

describe('__stream() CRUD max trimming', () => {
	it('prepend mode drops oldest items from the end when exceeding max', async () => {
		const store = __stream('feed/entries', { merge: 'crud', key: 'id', prepend: true, max: 3 });
		const values = [];
		const unsub = store.subscribe((v) => values.push(v));

		await flush();
		const sent = sendQueuedFn.mock.calls[0][0];
		simulateRpcResponse(sent.id, {
			ok: true,
			data: [{ id: 1 }, { id: 2 }, { id: 3 }],
			topic: 'feed',
			merge: 'crud',
			key: 'id',
			prepend: true,
			max: 3
		});

		// Add a 4th item (prepend) -- oldest (id:3 at the end) should be dropped
		simulateTopicMessage('feed', { event: 'created', data: { id: 4 } });

		const last = values[values.length - 1];
		expect(last).toHaveLength(3);
		expect(last[0].id).toBe(4);
		expect(last.map(i => i.id)).toEqual([4, 1, 2]);

		unsub();
	});

	it('append mode drops oldest items from the start when exceeding max', async () => {
		const store = __stream('log/entries', { merge: 'crud', key: 'id', max: 3 });
		const values = [];
		const unsub = store.subscribe((v) => values.push(v));

		await flush();
		const sent = sendQueuedFn.mock.calls[0][0];
		simulateRpcResponse(sent.id, {
			ok: true,
			data: [{ id: 1 }, { id: 2 }, { id: 3 }],
			topic: 'log',
			merge: 'crud',
			key: 'id',
			max: 3
		});

		// Add a 4th item (append) -- oldest (id:1 at the start) should be dropped
		simulateTopicMessage('log', { event: 'created', data: { id: 4 } });

		const last = values[values.length - 1];
		expect(last).toHaveLength(3);
		expect(last.map(i => i.id)).toEqual([2, 3, 4]);

		unsub();
	});

	it('does not trim when max is 0 (unlimited)', async () => {
		const store = __stream('all/items', { merge: 'crud', key: 'id' });
		const values = [];
		const unsub = store.subscribe((v) => values.push(v));

		await flush();
		const sent = sendQueuedFn.mock.calls[0][0];
		simulateRpcResponse(sent.id, {
			ok: true,
			data: Array.from({ length: 100 }, (_, i) => ({ id: i })),
			topic: 'all',
			merge: 'crud',
			key: 'id'
		});

		// Add more items -- nothing should be trimmed
		for (let i = 100; i < 110; i++) {
			simulateTopicMessage('all', { event: 'created', data: { id: i } });
		}

		const last = values[values.length - 1];
		expect(last).toHaveLength(110);

		unsub();
	});

	it('updates still work on items after trimming', async () => {
		const store = __stream('trim/update', { merge: 'crud', key: 'id', prepend: true, max: 2 });
		const values = [];
		const unsub = store.subscribe((v) => values.push(v));

		await flush();
		const sent = sendQueuedFn.mock.calls[0][0];
		simulateRpcResponse(sent.id, {
			ok: true,
			data: [{ id: 1, n: 'A' }, { id: 2, n: 'B' }],
			topic: 'trim-u',
			merge: 'crud',
			key: 'id',
			prepend: true,
			max: 2
		});

		// Add id:3 (prepend), id:2 gets dropped (oldest at end)
		simulateTopicMessage('trim-u', { event: 'created', data: { id: 3, n: 'C' } });

		// Update id:1 which is still in the buffer
		simulateTopicMessage('trim-u', { event: 'updated', data: { id: 1, n: 'A2' } });

		const last = values[values.length - 1];
		expect(last).toHaveLength(2);
		const item1 = last.find(i => i.id === 1);
		expect(item1.n).toBe('A2');

		unsub();
	});

	it('duplicate created event does not trigger trim (in-place update)', async () => {
		const store = __stream('dup/max', { merge: 'crud', key: 'id', max: 3 });
		const values = [];
		const unsub = store.subscribe((v) => values.push(v));

		await flush();
		const sent = sendQueuedFn.mock.calls[0][0];
		simulateRpcResponse(sent.id, {
			ok: true,
			data: [{ id: 1 }, { id: 2 }, { id: 3 }],
			topic: 'dup',
			merge: 'crud',
			key: 'id',
			max: 3
		});

		// Re-create existing item -- should update in place, not grow
		simulateTopicMessage('dup', { event: 'created', data: { id: 2, extra: true } });

		const last = values[values.length - 1];
		expect(last).toHaveLength(3);
		expect(last.find(i => i.id === 2).extra).toBe(true);

		unsub();
	});

	it('server-provided max overrides build-time default', async () => {
		const store = __stream('override/max', { merge: 'crud', key: 'id', prepend: true });
		const values = [];
		const unsub = store.subscribe((v) => values.push(v));

		await flush();
		const sent = sendQueuedFn.mock.calls[0][0];
		simulateRpcResponse(sent.id, {
			ok: true,
			data: [{ id: 1 }, { id: 2 }],
			topic: 'override',
			merge: 'crud',
			key: 'id',
			prepend: true,
			max: 2
		});

		simulateTopicMessage('override', { event: 'created', data: { id: 3 } });

		const last = values[values.length - 1];
		expect(last).toHaveLength(2);
		expect(last[0].id).toBe(3);

		unsub();
	});
});

// -- stream .error and .status stores -----------------------------------------

describe('stream .error and .status', () => {
	it('starts with status loading and error null', async () => {
		const store = __stream('err/test', { merge: 'crud', key: 'id' });
		const errors = [];
		const statuses = [];
		store.error.subscribe((v) => errors.push(v));
		store.status.subscribe((v) => statuses.push(v));
		const unsub = store.subscribe(() => {});
		await flush();

		expect(errors[0]).toBe(null);
		expect(statuses[0]).toBe('loading');
		unsub();
	});

	it('transitions to connected on successful fetch', async () => {
		const store = __stream('err/ok', { merge: 'crud', key: 'id' });
		const statuses = [];
		store.status.subscribe((v) => statuses.push(v));
		const unsub = store.subscribe(() => {});
		await flush();

		const sent = sendQueuedFn.mock.calls[0][0];
		simulateRpcResponse(sent.id, {
			ok: true, data: [{ id: 1 }], topic: 'errok', merge: 'crud', key: 'id'
		});

		expect(statuses[statuses.length - 1]).toBe('connected');
		unsub();
	});

	it('sets error store on reject without replacing data', async () => {
		const store = __stream('err/reject', { merge: 'crud', key: 'id' });
		const values = [];
		const errors = [];
		store.subscribe((v) => values.push(v));
		store.error.subscribe((v) => errors.push(v));
		await flush();

		const sent = sendQueuedFn.mock.calls[0][0];
		simulateRpcResponse(sent.id, {
			ok: true, data: [{ id: 1, text: 'hi' }], topic: 'errreject', merge: 'crud', key: 'id'
		});

		expect(values[values.length - 1]).toEqual([{ id: 1, text: 'hi' }]);

		simulateStatus('closed');
		simulateStatus('open');
		await new Promise((r) => setTimeout(r, 120));
		await flush();

		const sent2 = sendQueuedFn.mock.calls[sendQueuedFn.mock.calls.length - 1][0];
		simulateRpcResponse(sent2.id, { ok: false, code: 'STREAM_ERROR', error: 'Server down' });

		expect(values[values.length - 1]).toEqual([{ id: 1, text: 'hi' }]);
		const lastError = errors[errors.length - 1];
		expect(lastError).not.toBe(null);
		expect(lastError.code).toBe('STREAM_ERROR');
	});

	it('preserves hydrated data when initial fetch fails', async () => {
		const store = __stream('err/hydrate', { merge: 'crud', key: 'id' });
		store.hydrate([{ id: 1, name: 'ssr' }]);

		const values = [];
		const errors = [];
		const statuses = [];
		store.subscribe((v) => values.push(v));
		store.error.subscribe((v) => errors.push(v));
		store.status.subscribe((v) => statuses.push(v));

		expect(values[values.length - 1]).toEqual([{ id: 1, name: 'ssr' }]);

		await flush();
		const sent = sendQueuedFn.mock.calls[0][0];
		simulateRpcResponse(sent.id, { ok: false, code: 'UNAUTHORIZED', error: 'Not logged in' });

		expect(values[values.length - 1]).toEqual([{ id: 1, name: 'ssr' }]);
		expect(errors[errors.length - 1]).not.toBe(null);
		expect(errors[errors.length - 1].code).toBe('UNAUTHORIZED');
		expect(statuses[statuses.length - 1]).toBe('error');
	});

	it('clears error on successful reconnect', async () => {
		const store = __stream('err/reconnect', { merge: 'crud', key: 'id' });
		const errors = [];
		const statuses = [];
		store.error.subscribe((v) => errors.push(v));
		store.status.subscribe((v) => statuses.push(v));
		const unsub = store.subscribe(() => {});
		await flush();

		const sent = sendQueuedFn.mock.calls[0][0];
		simulateRpcResponse(sent.id, { ok: false, code: 'STREAM_ERROR', error: 'fail' });

		expect(errors[errors.length - 1]).not.toBe(null);
		expect(statuses[statuses.length - 1]).toBe('error');

		simulateStatus('closed');
		simulateStatus('open');

		expect(statuses[statuses.length - 1]).toBe('reconnecting');

		await new Promise((r) => setTimeout(r, 120));
		await flush();

		const sent2 = sendQueuedFn.mock.calls[sendQueuedFn.mock.calls.length - 1][0];
		simulateRpcResponse(sent2.id, {
			ok: true, data: [{ id: 2 }], topic: 'errreconnect', merge: 'crud', key: 'id'
		});

		expect(errors[errors.length - 1]).toBe(null);
		expect(statuses[statuses.length - 1]).toBe('connected');
		unsub();
	});

	it('sets error on terminal close without replacing data', async () => {
		const store = __stream('err/terminal', { merge: 'crud', key: 'id' });
		const values = [];
		const errors = [];
		store.subscribe((v) => values.push(v));
		store.error.subscribe((v) => errors.push(v));
		await flush();

		const sent = sendQueuedFn.mock.calls[0][0];
		simulateRpcResponse(sent.id, {
			ok: true, data: [{ id: 1 }], topic: 'errterminal', merge: 'crud', key: 'id'
		});

		expect(values[values.length - 1]).toEqual([{ id: 1 }]);

		readyReject({ code: 'CONNECTION_CLOSED', message: 'gone' });
		await new Promise((r) => setTimeout(r, 10));

		expect(values[values.length - 1]).toEqual([{ id: 1 }]);
		expect(errors[errors.length - 1]).not.toBe(null);
		expect(errors[errors.length - 1].code).toBe('CONNECTION_CLOSED');
	});

	it('resets error and status on cleanup and re-subscribe', async () => {
		const store = __stream('err/reset', { merge: 'crud', key: 'id' });
		const errors = [];
		const statuses = [];
		store.error.subscribe((v) => errors.push(v));
		store.status.subscribe((v) => statuses.push(v));

		const unsub = store.subscribe(() => {});
		await flush();
		const sent = sendQueuedFn.mock.calls[0][0];
		simulateRpcResponse(sent.id, { ok: false, code: 'TIMEOUT', error: 'slow' });

		expect(errors[errors.length - 1]).not.toBe(null);
		unsub();

		await new Promise((r) => queueMicrotask(r));

		expect(errors[errors.length - 1]).toBe(null);
		expect(statuses[statuses.length - 1]).toBe('loading');
	});

	it('dynamic streams expose .error and .status', async () => {
		const factory = __stream('err/dynamic', { merge: 'crud', key: 'id' }, true);
		const store = factory('org1');

		expect(store.error).toBeDefined();
		expect(typeof store.error.subscribe).toBe('function');
		expect(store.status).toBeDefined();
		expect(typeof store.status.subscribe).toBe('function');

		const errors = [];
		store.error.subscribe((v) => errors.push(v));
		expect(errors[0]).toBe(null);
	});
});

// -- empty store --------------------------------------------------------------

describe('empty store', () => {
	it('is a readable that holds undefined', async () => {
		const { empty } = await import('../client.js');
		const values = [];
		const unsub = empty.subscribe((v) => values.push(v));
		expect(values).toEqual([undefined]);
		unsub();
	});
});
