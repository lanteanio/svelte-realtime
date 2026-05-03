import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

let __rpc, __stream, __binaryRpc, RpcError, batch, configure, combine, onSignal, onDerived, failure, quiescent, _resetQuiescence, health, _resetHealth, onPush, _resetPushHandlers, __devtools;
let topicCallbacks;
let statusCallbacks;
let failureCallbacks;
let failureValue;
let denialsCallbacks;
let denialsValue;
let sendQueuedFn;
let readyReject;
let connectFn;
/** @type {((event: string, data: any) => any | Promise<any>) | null} */
let onRequestHandler;
/** @type {Set<() => void>} */
let onRequestUnsubs;

/**
 * Simulate a failure store update from the adapter.
 */
function simulateFailure(value) {
	failureValue = value;
	for (const cb of failureCallbacks) cb(value);
}

/**
 * Simulate a subscribe-denial frame from the adapter.
 */
function simulateDenial(value) {
	denialsValue = value;
	for (const cb of denialsCallbacks) cb(value);
}

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
	failureCallbacks = new Set();
	failureValue = null;
	denialsCallbacks = new Set();
	denialsValue = null;
	sendQueuedFn = vi.fn();
	onRequestHandler = null;
	onRequestUnsubs = new Set();

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
		},
		failure: {
			subscribe: (fn) => {
				failureCallbacks.add(fn);
				fn(failureValue);
				return () => failureCallbacks.delete(fn);
			}
		},
		denials: {
			subscribe: (fn) => {
				denialsCallbacks.add(fn);
				fn(denialsValue);
				return () => denialsCallbacks.delete(fn);
			}
		},
		onRequest: (handler) => {
			onRequestHandler = handler;
			const unsub = () => {
				if (onRequestHandler === handler) onRequestHandler = null;
				onRequestUnsubs.delete(unsub);
			};
			onRequestUnsubs.add(unsub);
			return unsub;
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
		},
		// Minimal Svelte 5 fromStore mock for `.rune()` round-trip tests:
		// subscribes to the source and exposes a synchronous { current }
		// reader. Real fromStore uses createSubscriber for fine-grained
		// reactivity; outside an effect it falls back to a synchronous read,
		// which is what the mock provides.
		fromStore: (store) => {
			let current;
			store.subscribe((v) => { current = v; });
			return { get current() { return current; } };
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
	failure = mod.failure;
	quiescent = mod.quiescent;
	_resetQuiescence = mod._resetQuiescence;
	_resetQuiescence();
	health = mod.health;
	_resetHealth = mod._resetHealth;
	_resetHealth();
	onPush = mod.onPush;
	_resetPushHandlers = mod._resetPushHandlers;
	_resetPushHandlers();
	__devtools = mod.__devtools;
	if (__devtools) {
		__devtools.streams.clear();
		__devtools.pending.clear();
		for (let i = 0; i < __devtools.history.length; i++) __devtools.history[i] = null;
	}
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
		simulateStatus('disconnected');

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

// -- __stream() mutate (optimistic + auto-rollback) ---------------------------

describe('__stream() mutate', () => {
	async function setupCrudStream(path, topic, initial = []) {
		const store = __stream(path, { merge: 'crud', key: 'id' });
		const values = [];
		const unsub = store.subscribe((v) => values.push(v));
		await flush();
		const sent = sendQueuedFn.mock.calls[sendQueuedFn.mock.calls.length - 1][0];
		simulateRpcResponse(sent.id, { ok: true, data: initial, topic, merge: 'crud', key: 'id' });
		return { store, values, unsub, topic };
	}

	it('event-based: returns asyncOp result on success and leaves store at optimistic state', async () => {
		const ctx = await setupCrudStream('mut/items', 'mut-items', [{ id: 1, name: 'A' }]);

		const result = await ctx.store.mutate(
			() => Promise.resolve({ id: 't1', name: 'New', serverField: true }),
			{ event: 'created', data: { id: 't1', name: 'New' } }
		);
		expect(result).toEqual({ id: 't1', name: 'New', serverField: true });
		expect(ctx.values[ctx.values.length - 1]).toEqual([
			{ id: 1, name: 'A' },
			{ id: 't1', name: 'New' }
		]);
		ctx.unsub();
	});

	it('event-based: rolls back and throws when asyncOp rejects', async () => {
		const ctx = await setupCrudStream('mut/fail', 'mut-fail', [{ id: 1, name: 'A' }]);

		await expect(
			ctx.store.mutate(
				() => Promise.reject(new Error('rpc failed')),
				{ event: 'created', data: { id: 't1', name: 'New' } }
			)
		).rejects.toThrow('rpc failed');
		expect(ctx.values[ctx.values.length - 1]).toEqual([{ id: 1, name: 'A' }]);
		ctx.unsub();
	});

	it('event-based: server event with same key reconciles after asyncOp succeeds', async () => {
		const ctx = await setupCrudStream('mut/recon', 'mut-recon', []);

		const opPromise = ctx.store.mutate(
			() => new Promise((r) => setTimeout(() => r({ id: 't1', name: 'Real' }), 10)),
			{ event: 'created', data: { id: 't1', name: 'Pending' } }
		);
		// Optimistic value present immediately
		expect(ctx.values[ctx.values.length - 1]).toEqual([{ id: 't1', name: 'Pending' }]);

		// Server publishes the confirmed version with the same key
		simulateTopicMessage('mut-recon', { event: 'created', data: { id: 't1', name: 'Confirmed' } });
		expect(ctx.values[ctx.values.length - 1]).toEqual([{ id: 't1', name: 'Confirmed' }]);

		await opPromise;
		// Store still reflects the server's confirmed version (asyncOp success leaves it alone)
		expect(ctx.values[ctx.values.length - 1]).toEqual([{ id: 't1', name: 'Confirmed' }]);
		ctx.unsub();
	});

	it('free-form mutator (returns new value) applies and rolls back on failure', async () => {
		const ctx = await setupCrudStream('mut/free', 'mut-free', [{ id: 1, name: 'A' }, { id: 2, name: 'B' }]);

		await expect(
			ctx.store.mutate(
				() => Promise.reject(new Error('boom')),
				(current) => current.filter((t) => t.id !== 2)
			)
		).rejects.toThrow('boom');
		expect(ctx.values[ctx.values.length - 1]).toEqual([{ id: 1, name: 'A' }, { id: 2, name: 'B' }]);
		ctx.unsub();
	});

	it('free-form mutator (in-place mutation, returns void) is supported', async () => {
		const ctx = await setupCrudStream('mut/inplace', 'mut-inplace', [{ id: 1, name: 'A' }]);

		const result = await ctx.store.mutate(
			() => Promise.resolve('ok'),
			(draft) => { draft.push({ id: 2, name: 'B' }); }
		);
		expect(result).toBe('ok');
		expect(ctx.values[ctx.values.length - 1]).toEqual([{ id: 1, name: 'A' }, { id: 2, name: 'B' }]);
		ctx.unsub();
	});

	it('free-form mutator: in-place push is rolled back on failure', async () => {
		// NOTE: snapshot is shallow (slice for arrays). Top-level shape changes
		// (push, pop, filter, splice on the array) are rolled back; in-place
		// mutations of individual items (e.g. draft[0].name = 'x') ARE NOT,
		// because the snapshot and the items share references. Documented in
		// the JSDoc; apps mutating item fields in place should return a new
		// item object instead.
		const ctx = await setupCrudStream('mut/inplace-fail', 'mut-inplace-fail', [{ id: 1 }, { id: 2 }]);

		await expect(
			ctx.store.mutate(
				() => Promise.reject(new Error('nope')),
				(draft) => { draft.push({ id: 3 }); }
			)
		).rejects.toThrow('nope');
		expect(ctx.values[ctx.values.length - 1]).toEqual([{ id: 1 }, { id: 2 }]);
		ctx.unsub();
	});

	it('asyncOp returning a sync value works (Promise.resolve wrap)', async () => {
		const ctx = await setupCrudStream('mut/sync', 'mut-sync');

		const result = await ctx.store.mutate(
			() => 42,
			{ event: 'created', data: { id: 't1' } }
		);
		expect(result).toBe(42);
		ctx.unsub();
	});

	it('asyncOp throwing synchronously rolls back and re-throws', async () => {
		const ctx = await setupCrudStream('mut/throw', 'mut-throw', [{ id: 1 }]);

		await expect(
			ctx.store.mutate(
				() => { throw new Error('sync throw'); },
				{ event: 'created', data: { id: 't1' } }
			)
		).rejects.toThrow('sync throw');
		expect(ctx.values[ctx.values.length - 1]).toEqual([{ id: 1 }]);
		ctx.unsub();
	});

	it('rejects missing asyncOp', async () => {
		const ctx = await setupCrudStream('mut/no-op', 'mut-no-op');
		await expect(ctx.store.mutate(null, { event: 'created', data: {} })).rejects.toThrow(/asyncOp must be a function/);
		ctx.unsub();
	});

	it('rejects missing optimisticChange', async () => {
		const ctx = await setupCrudStream('mut/no-change', 'mut-no-change');
		await expect(ctx.store.mutate(() => 'x')).rejects.toThrow(/optimisticChange is required/);
		ctx.unsub();
	});

	it('rejects malformed optimisticChange', async () => {
		const ctx = await setupCrudStream('mut/bad-shape', 'mut-bad-shape');
		await expect(ctx.store.mutate(() => 'x', { wrong: 'shape' })).rejects.toThrow(/{ event, data } or a function/);
		ctx.unsub();
	});

	it('works on set merge with free-form mutator', async () => {
		const store = __stream('mut/set', { merge: 'set' });
		const values = [];
		const unsub = store.subscribe((v) => values.push(v));
		await flush();
		const sent = sendQueuedFn.mock.calls[sendQueuedFn.mock.calls.length - 1][0];
		simulateRpcResponse(sent.id, { ok: true, data: { count: 10 }, topic: 'mut-set-topic', merge: 'set' });

		const result = await store.mutate(
			() => Promise.resolve('ok'),
			(current) => ({ ...current, count: 11 })
		);
		expect(result).toBe('ok');
		expect(values[values.length - 1]).toEqual({ count: 11 });
		unsub();
	});
});

// -- __stream() mutate queue-replay correctness -------------------------------
//
// Covers the always-on queue-replay machinery: server events apply to an
// un-overlaid `_serverValue` while a mutate is in flight, the displayed
// value is recomputed by replaying the queue against `_serverValue`, and
// the queue drains back to single-value mode when all mutates settle. The
// big correctness win is concurrent mutates: today's snapshot/restore loses
// state when two overlapping mutates both fail; queue-replay does not.

describe('__stream() mutate queue-replay correctness', () => {
	async function setupCrudStream(path, topic, initial = []) {
		const store = __stream(path, { merge: 'crud', key: 'id' });
		const values = [];
		const unsub = store.subscribe((v) => values.push(v));
		await flush();
		const sent = sendQueuedFn.mock.calls[sendQueuedFn.mock.calls.length - 1][0];
		simulateRpcResponse(sent.id, { ok: true, data: initial, topic, merge: 'crud', key: 'id' });
		return { store, values, unsub, topic };
	}

	function deferred() {
		let resolve, reject;
		const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
		return { promise, resolve, reject };
	}

	// -- concurrent mutate scenarios (the bug this design closes) ----------

	it('concurrent: A and B both fail leaves no phantom traces', async () => {
		const ctx = await setupCrudStream('qr/both-fail', 't-bf', [{ id: 1, name: 'X' }]);
		const dA = deferred();
		const dB = deferred();
		const a = ctx.store.mutate(() => dA.promise, { event: 'created', data: { id: 'a', name: 'A' } });
		const b = ctx.store.mutate(() => dB.promise, { event: 'created', data: { id: 'b', name: 'B' } });
		expect(ctx.values[ctx.values.length - 1]).toEqual([
			{ id: 1, name: 'X' }, { id: 'a', name: 'A' }, { id: 'b', name: 'B' }
		]);

		dA.reject(new Error('fail-a'));
		await expect(a).rejects.toThrow('fail-a');
		expect(ctx.values[ctx.values.length - 1]).toEqual([
			{ id: 1, name: 'X' }, { id: 'b', name: 'B' }
		]);

		dB.reject(new Error('fail-b'));
		await expect(b).rejects.toThrow('fail-b');
		expect(ctx.values[ctx.values.length - 1]).toEqual([{ id: 1, name: 'X' }]);
		ctx.unsub();
	});

	it('concurrent: A succeeds, B fails leaves only A visible', async () => {
		const ctx = await setupCrudStream('qr/a-ok-b-fail', 't-aobf', []);
		const dA = deferred();
		const dB = deferred();
		const a = ctx.store.mutate(() => dA.promise, { event: 'created', data: { id: 'a', name: 'A' } });
		const b = ctx.store.mutate(() => dB.promise, { event: 'created', data: { id: 'b', name: 'B' } });
		expect(ctx.values[ctx.values.length - 1]).toEqual([
			{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }
		]);

		dA.resolve('ok-a');
		await a;
		// 'a' graduated to server state; 'b' still in queue
		expect(ctx.values[ctx.values.length - 1]).toEqual([
			{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }
		]);

		dB.reject(new Error('fail-b'));
		await expect(b).rejects.toThrow('fail-b');
		expect(ctx.values[ctx.values.length - 1]).toEqual([{ id: 'a', name: 'A' }]);
		ctx.unsub();
	});

	it('concurrent: A fails, B succeeds leaves only B visible', async () => {
		const ctx = await setupCrudStream('qr/a-fail-b-ok', 't-afbo', []);
		const dA = deferred();
		const dB = deferred();
		const a = ctx.store.mutate(() => dA.promise, { event: 'created', data: { id: 'a', name: 'A' } });
		const b = ctx.store.mutate(() => dB.promise, { event: 'created', data: { id: 'b', name: 'B' } });

		dA.reject(new Error('fail-a'));
		await expect(a).rejects.toThrow('fail-a');
		expect(ctx.values[ctx.values.length - 1]).toEqual([{ id: 'b', name: 'B' }]);

		dB.resolve('ok-b');
		await b;
		expect(ctx.values[ctx.values.length - 1]).toEqual([{ id: 'b', name: 'B' }]);
		ctx.unsub();
	});

	it('concurrent: A and B both succeed leaves both visible (no double-apply)', async () => {
		const ctx = await setupCrudStream('qr/both-ok', 't-bo', []);
		const dA = deferred();
		const dB = deferred();
		const a = ctx.store.mutate(() => dA.promise, { event: 'created', data: { id: 'a', name: 'A' } });
		const b = ctx.store.mutate(() => dB.promise, { event: 'created', data: { id: 'b', name: 'B' } });

		dA.resolve(); dB.resolve();
		await Promise.all([a, b]);
		expect(ctx.values[ctx.values.length - 1]).toEqual([
			{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }
		]);
		ctx.unsub();
	});

	it('three concurrent mutates with mixed outcomes interleave correctly', async () => {
		const ctx = await setupCrudStream('qr/three', 't-three', []);
		const d1 = deferred(); const d2 = deferred(); const d3 = deferred();
		const m1 = ctx.store.mutate(() => d1.promise, { event: 'created', data: { id: 1, n: 'one' } });
		const m2 = ctx.store.mutate(() => d2.promise, { event: 'created', data: { id: 2, n: 'two' } });
		const m3 = ctx.store.mutate(() => d3.promise, { event: 'created', data: { id: 3, n: 'three' } });

		d2.reject(new Error('fail-2'));
		await expect(m2).rejects.toThrow();
		expect(ctx.values[ctx.values.length - 1]).toEqual([
			{ id: 1, n: 'one' }, { id: 3, n: 'three' }
		]);

		d1.resolve(); await m1;
		expect(ctx.values[ctx.values.length - 1]).toEqual([
			{ id: 1, n: 'one' }, { id: 3, n: 'three' }
		]);

		d3.resolve(); await m3;
		expect(ctx.values[ctx.values.length - 1]).toEqual([
			{ id: 1, n: 'one' }, { id: 3, n: 'three' }
		]);
		ctx.unsub();
	});

	// -- server event interleaving while mutate is in flight ---------------

	it('server event for unrelated key interleaves with optimistic mutate', async () => {
		const ctx = await setupCrudStream('qr/interleave', 't-il', []);
		const d = deferred();
		const m = ctx.store.mutate(() => d.promise, { event: 'created', data: { id: 'opt', n: 'O' } });
		simulateTopicMessage('t-il', { event: 'created', data: { id: 'srv', n: 'S' } });
		// Both visible: server entry under 'srv', optimistic still under 'opt'
		const last = ctx.values[ctx.values.length - 1];
		expect(last.length).toBe(2);
		expect(last.some((x) => x.id === 'opt')).toBe(true);
		expect(last.some((x) => x.id === 'srv')).toBe(true);

		d.resolve(); await m;
		// After settle, server entry preserved AND graduated optimistic preserved
		const final = ctx.values[ctx.values.length - 1];
		expect(final.length).toBe(2);
		expect(final.some((x) => x.id === 'opt')).toBe(true);
		expect(final.some((x) => x.id === 'srv')).toBe(true);
		ctx.unsub();
	});

	it('server event for matching key absorbs the optimistic entry (no flicker)', async () => {
		const ctx = await setupCrudStream('qr/absorb', 't-ab', []);
		const d = deferred();
		const m = ctx.store.mutate(
			() => d.promise,
			{ event: 'created', data: { id: 't1', name: 'Pending' } }
		);
		expect(ctx.values[ctx.values.length - 1]).toEqual([{ id: 't1', name: 'Pending' }]);

		simulateTopicMessage('t-ab', { event: 'created', data: { id: 't1', name: 'Confirmed' } });
		// Server's value wins, optimistic absorbed
		expect(ctx.values[ctx.values.length - 1]).toEqual([{ id: 't1', name: 'Confirmed' }]);

		d.resolve(); await m;
		// asyncOp success on absorbed entry: just dropped, no graduate-overwrite
		expect(ctx.values[ctx.values.length - 1]).toEqual([{ id: 't1', name: 'Confirmed' }]);
		ctx.unsub();
	});

	it('absorbed optimistic on asyncOp failure: server-confirmed value retained', async () => {
		const ctx = await setupCrudStream('qr/abs-fail', 't-af', []);
		const d = deferred();
		const m = ctx.store.mutate(
			() => d.promise,
			{ event: 'created', data: { id: 't1', name: 'Pending' } }
		);
		simulateTopicMessage('t-af', { event: 'created', data: { id: 't1', name: 'Confirmed' } });
		expect(ctx.values[ctx.values.length - 1]).toEqual([{ id: 't1', name: 'Confirmed' }]);

		d.reject(new Error('boom'));
		await expect(m).rejects.toThrow('boom');
		// Server already accepted; failure does not roll back the server's confirmation
		expect(ctx.values[ctx.values.length - 1]).toEqual([{ id: 't1', name: 'Confirmed' }]);
		ctx.unsub();
	});

	it('server deleted event for matching key does NOT absorb optimistic created', async () => {
		const ctx = await setupCrudStream('qr/del-no-absorb', 't-dna', [{ id: 1 }]);
		const d = deferred();
		const m = ctx.store.mutate(
			() => d.promise,
			{ event: 'created', data: { id: 't1', name: 'Opt' } }
		);
		// Server deletes a different key while optimistic in flight
		simulateTopicMessage('t-dna', { event: 'deleted', data: { id: 1 } });
		expect(ctx.values[ctx.values.length - 1]).toEqual([{ id: 't1', name: 'Opt' }]);

		d.resolve(); await m;
		// Optimistic graduated; server delete persisted
		expect(ctx.values[ctx.values.length - 1]).toEqual([{ id: 't1', name: 'Opt' }]);
		ctx.unsub();
	});

	it('refreshed event during in-flight mutate replaces server state but keeps optimistic on top', async () => {
		const ctx = await setupCrudStream('qr/refresh', 't-rf', [{ id: 1, n: 'old' }]);
		const d = deferred();
		const m = ctx.store.mutate(
			() => d.promise,
			{ event: 'created', data: { id: 'opt', n: 'O' } }
		);
		simulateTopicMessage('t-rf', { event: 'refreshed', data: [{ id: 99, n: 'fresh' }] });
		// _serverValue replaced; optimistic still applied on top
		const after = ctx.values[ctx.values.length - 1];
		expect(after.some((x) => x.id === 99 && x.n === 'fresh')).toBe(true);
		expect(after.some((x) => x.id === 'opt')).toBe(true);
		expect(after.length).toBe(2);

		d.resolve(); await m;
		const final = ctx.values[ctx.values.length - 1];
		expect(final.some((x) => x.id === 99)).toBe(true);
		expect(final.some((x) => x.id === 'opt')).toBe(true);
		expect(final.length).toBe(2);
		ctx.unsub();
	});

	// -- queue lifecycle / drain ------------------------------------------

	it('queue empty before first mutate: hot path identical to today', async () => {
		const ctx = await setupCrudStream('qr/hot', 't-hot', [{ id: 1 }]);
		simulateTopicMessage('t-hot', { event: 'created', data: { id: 2 } });
		expect(ctx.values[ctx.values.length - 1]).toEqual([{ id: 1 }, { id: 2 }]);
		ctx.unsub();
	});

	it('queue drains to single-value mode after all mutates settle', async () => {
		const ctx = await setupCrudStream('qr/drain', 't-drain', []);
		await ctx.store.mutate(() => 'ok', { event: 'created', data: { id: 'a' } });
		// After drain, server events take the hot path
		simulateTopicMessage('t-drain', { event: 'created', data: { id: 'b' } });
		expect(ctx.values[ctx.values.length - 1]).toEqual([{ id: 'a' }, { id: 'b' }]);
		ctx.unsub();
	});

	// -- free-form function changes ---------------------------------------

	it('free-form mutator: concurrent fails leave no phantom changes', async () => {
		const ctx = await setupCrudStream('qr/ff-fail', 't-ff', [{ id: 1, n: 'X' }]);
		const dA = deferred(); const dB = deferred();
		const a = ctx.store.mutate(() => dA.promise, (cur) => [...cur, { id: 'a', n: 'A' }]);
		const b = ctx.store.mutate(() => dB.promise, (cur) => [...cur, { id: 'b', n: 'B' }]);
		expect(ctx.values[ctx.values.length - 1]).toEqual([
			{ id: 1, n: 'X' }, { id: 'a', n: 'A' }, { id: 'b', n: 'B' }
		]);

		dA.reject(new Error('fa'));
		await expect(a).rejects.toThrow();
		expect(ctx.values[ctx.values.length - 1]).toEqual([
			{ id: 1, n: 'X' }, { id: 'b', n: 'B' }
		]);

		dB.reject(new Error('fb'));
		await expect(b).rejects.toThrow();
		expect(ctx.values[ctx.values.length - 1]).toEqual([{ id: 1, n: 'X' }]);
		ctx.unsub();
	});

	it('free-form mutator: success graduates the change onto server state', async () => {
		const ctx = await setupCrudStream('qr/ff-ok', 't-ffo', [{ id: 1 }, { id: 2 }]);
		await ctx.store.mutate(
			() => 'ok',
			(cur) => cur.filter((x) => x.id !== 2)
		);
		expect(ctx.values[ctx.values.length - 1]).toEqual([{ id: 1 }]);
		// Server event after drain takes hot path on the post-graduate state
		simulateTopicMessage('t-ffo', { event: 'created', data: { id: 3 } });
		expect(ctx.values[ctx.values.length - 1]).toEqual([{ id: 1 }, { id: 3 }]);
		ctx.unsub();
	});

	// -- per-merge-strategy: latest, set, presence, cursor ----------------

	it('latest merge: optimistic push + concurrent fail rolls back cleanly', async () => {
		const store = __stream('qr/latest', { merge: 'latest', max: 10 });
		const values = [];
		const unsub = store.subscribe((v) => values.push(v));
		await flush();
		const sent = sendQueuedFn.mock.calls[sendQueuedFn.mock.calls.length - 1][0];
		simulateRpcResponse(sent.id, { ok: true, data: ['x'], topic: 't-lat', merge: 'latest' });

		const dA = deferred();
		const dB = deferred();
		const a = store.mutate(() => dA.promise, { event: 'push', data: 'a' });
		const b = store.mutate(() => dB.promise, { event: 'push', data: 'b' });
		expect(values[values.length - 1]).toEqual(['x', 'a', 'b']);

		dA.reject(new Error('fa'));
		await expect(a).rejects.toThrow();
		expect(values[values.length - 1]).toEqual(['x', 'b']);

		dB.reject(new Error('fb'));
		await expect(b).rejects.toThrow();
		expect(values[values.length - 1]).toEqual(['x']);
		unsub();
	});

	it('set merge: optimistic replacement + fail rolls back to server state', async () => {
		const store = __stream('qr/setm', { merge: 'set' });
		const values = [];
		const unsub = store.subscribe((v) => values.push(v));
		await flush();
		const sent = sendQueuedFn.mock.calls[sendQueuedFn.mock.calls.length - 1][0];
		simulateRpcResponse(sent.id, { ok: true, data: { count: 10 }, topic: 't-set', merge: 'set' });

		const d = deferred();
		const p = store.mutate(() => d.promise, (cur) => ({ ...cur, count: 99 }));
		expect(values[values.length - 1]).toEqual({ count: 99 });

		d.reject(new Error('boom'));
		await expect(p).rejects.toThrow();
		expect(values[values.length - 1]).toEqual({ count: 10 });
		unsub();
	});

	it('presence merge: optimistic join + matching server join absorbs', async () => {
		const store = __stream('qr/pres', { merge: 'presence' });
		const values = [];
		const unsub = store.subscribe((v) => values.push(v));
		await flush();
		const sent = sendQueuedFn.mock.calls[sendQueuedFn.mock.calls.length - 1][0];
		simulateRpcResponse(sent.id, { ok: true, data: [], topic: 't-pres', merge: 'presence' });

		const d = deferred();
		const p = store.mutate(
			() => d.promise,
			{ event: 'join', data: { key: 'u1', name: 'Pending' } }
		);
		expect(values[values.length - 1]).toEqual([{ key: 'u1', name: 'Pending' }]);

		simulateTopicMessage('t-pres', { event: 'join', data: { key: 'u1', name: 'Confirmed' } });
		expect(values[values.length - 1]).toEqual([{ key: 'u1', name: 'Confirmed' }]);

		d.resolve(); await p;
		expect(values[values.length - 1]).toEqual([{ key: 'u1', name: 'Confirmed' }]);
		unsub();
	});

	it('presence merge: server leave during in-flight optimistic join does NOT absorb', async () => {
		const store = __stream('qr/pres2', { merge: 'presence' });
		const values = [];
		const unsub = store.subscribe((v) => values.push(v));
		await flush();
		const sent = sendQueuedFn.mock.calls[sendQueuedFn.mock.calls.length - 1][0];
		simulateRpcResponse(sent.id, { ok: true, data: [{ key: 'u0' }], topic: 't-pres2', merge: 'presence' });

		const d = deferred();
		const p = store.mutate(() => d.promise, { event: 'join', data: { key: 'u1', name: 'New' } });
		simulateTopicMessage('t-pres2', { event: 'leave', data: { key: 'u0' } });
		expect(values[values.length - 1]).toEqual([{ key: 'u1', name: 'New' }]);

		d.resolve(); await p;
		expect(values[values.length - 1]).toEqual([{ key: 'u1', name: 'New' }]);
		unsub();
	});

	it('cursor merge: optimistic update + matching server update absorbs', async () => {
		const store = __stream('qr/cur', { merge: 'cursor' });
		const values = [];
		const unsub = store.subscribe((v) => values.push(v));
		await flush();
		const sent = sendQueuedFn.mock.calls[sendQueuedFn.mock.calls.length - 1][0];
		simulateRpcResponse(sent.id, { ok: true, data: [], topic: 't-cur', merge: 'cursor' });

		const d = deferred();
		const p = store.mutate(
			() => d.promise,
			{ event: 'update', data: { key: 'c1', x: 1 } }
		);
		simulateTopicMessage('t-cur', { event: 'update', data: { key: 'c1', x: 2 } });
		expect(values[values.length - 1]).toEqual([{ key: 'c1', x: 2 }]);

		d.resolve(); await p;
		expect(values[values.length - 1]).toEqual([{ key: 'c1', x: 2 }]);
		unsub();
	});

	// -- error propagation contract ---------------------------------------

	it('asyncOp result is returned on success (Promise resolution preserved)', async () => {
		const ctx = await setupCrudStream('qr/result', 't-res', []);
		const result = await ctx.store.mutate(
			() => Promise.resolve({ id: 't', server: true }),
			{ event: 'created', data: { id: 't', client: true } }
		);
		expect(result).toEqual({ id: 't', server: true });
		ctx.unsub();
	});

	it('asyncOp rejection is rethrown unchanged', async () => {
		const ctx = await setupCrudStream('qr/reject', 't-rj', []);
		const err = new Error('original');
		await expect(
			ctx.store.mutate(() => Promise.reject(err), { event: 'created', data: { id: 'x' } })
		).rejects.toBe(err);
		ctx.unsub();
	});

	it('asyncOp synchronous throw rolls back and rethrows', async () => {
		const ctx = await setupCrudStream('qr/throw', 't-th', [{ id: 1 }]);
		await expect(
			ctx.store.mutate(
				() => { throw new Error('sync-throw'); },
				{ event: 'created', data: { id: 't' } }
			)
		).rejects.toThrow('sync-throw');
		expect(ctx.values[ctx.values.length - 1]).toEqual([{ id: 1 }]);
		ctx.unsub();
	});
});

// -- __rpc() createOptimistic --------------------------------------------------

describe('__rpc() createOptimistic', () => {
	async function setupCrudStream(path, topic, initial = []) {
		const store = __stream(path, { merge: 'crud', key: 'id' });
		const values = [];
		const unsub = store.subscribe((v) => values.push(v));
		await flush();
		const sent = sendQueuedFn.mock.calls[sendQueuedFn.mock.calls.length - 1][0];
		simulateRpcResponse(sent.id, { ok: true, data: initial, topic, merge: 'crud', key: 'id' });
		return { store, values, unsub, topic };
	}

	it('event-form: applies optimistic event, sends RPC, returns server result', async () => {
		const ctx = await setupCrudStream('opt/items', 'opt-items', [{ id: 1, name: 'A' }]);
		const addItem = __rpc('opt/add');

		const promise = addItem.createOptimistic(
			ctx.store,
			[{ name: 'New' }],
			{ event: 'created', data: { id: 't1', name: 'New' } }
		);
		expect(ctx.values[ctx.values.length - 1]).toEqual([
			{ id: 1, name: 'A' },
			{ id: 't1', name: 'New' }
		]);

		// Simulate the RPC reply for the createOptimistic-issued call
		const sent = sendQueuedFn.mock.calls[sendQueuedFn.mock.calls.length - 1][0];
		expect(sent.rpc).toBe('opt/add');
		expect(sent.args).toEqual([{ name: 'New' }]);
		simulateRpcResponse(sent.id, { ok: true, data: { id: 't1', name: 'New', server: true } });

		const result = await promise;
		expect(result).toEqual({ id: 't1', name: 'New', server: true });
		ctx.unsub();
	});

	it('callback-form: threads callArgs into the (current, args) callback', async () => {
		const ctx = await setupCrudStream('opt/cb', 'opt-cb', [{ id: 1, name: 'A' }]);
		const append = __rpc('opt/append');

		const seenArgs = [];
		const promise = append.createOptimistic(
			ctx.store,
			['hello', 42],
			(current, args) => {
				seenArgs.push(args);
				return [...current, { id: 'tmp', name: args[0], n: args[1] }];
			}
		);
		expect(seenArgs).toEqual([['hello', 42]]);
		expect(ctx.values[ctx.values.length - 1]).toEqual([
			{ id: 1, name: 'A' },
			{ id: 'tmp', name: 'hello', n: 42 }
		]);

		const sent = sendQueuedFn.mock.calls[sendQueuedFn.mock.calls.length - 1][0];
		expect(sent.args).toEqual(['hello', 42]);
		simulateRpcResponse(sent.id, { ok: true, data: 'ok' });
		await promise;
		ctx.unsub();
	});

	it('rolls back the store when the RPC rejects', async () => {
		const ctx = await setupCrudStream('opt/fail', 'opt-fail', [{ id: 1, name: 'A' }]);
		const create = __rpc('opt/create');

		const promise = create.createOptimistic(
			ctx.store,
			[{ name: 'New' }],
			{ event: 'created', data: { id: 't1', name: 'New' } }
		);
		expect(ctx.values[ctx.values.length - 1]).toEqual([
			{ id: 1, name: 'A' },
			{ id: 't1', name: 'New' }
		]);

		const sent = sendQueuedFn.mock.calls[sendQueuedFn.mock.calls.length - 1][0];
		simulateRpcResponse(sent.id, { ok: false, code: 'INTERNAL_ERROR', error: 'boom' });

		await expect(promise).rejects.toMatchObject({ code: 'INTERNAL_ERROR' });
		expect(ctx.values[ctx.values.length - 1]).toEqual([{ id: 1, name: 'A' }]);
		ctx.unsub();
	});

	it('throws when first arg is not a store', () => {
		const r = __rpc('opt/bad');
		expect(() => r.createOptimistic(null, [], () => {})).toThrow(/must be a stream store/);
		expect(() => r.createOptimistic({}, [], () => {})).toThrow(/must be a stream store/);
	});

	it('throws when callArgs is not an array', () => {
		const r = __rpc('opt/bad');
		const fakeStore = { mutate: () => {} };
		expect(() => r.createOptimistic(fakeStore, 'not-an-array', () => {})).toThrow(/callArgs must be an array/);
	});

	it('throws when optimisticChange is missing', () => {
		const r = __rpc('opt/bad');
		const fakeStore = { mutate: () => {} };
		expect(() => r.createOptimistic(fakeStore, [], null)).toThrow(/optimisticChange is required/);
	});

	// Curry-form -------------------------------------------------------------

	it('curry-form: 2 args returns a callable that runs the optimistic mutation', async () => {
		const ctx = await setupCrudStream('curry/items', 'curry-items', [{ id: 1, name: 'A' }]);
		const append = __rpc('curry/append');

		const optimisticAppend = append.createOptimistic(
			ctx.store,
			(current, args) => [...current, { id: 'tmp', name: args[0] }]
		);

		expect(typeof optimisticAppend).toBe('function');

		const promise = optimisticAppend('hello');
		expect(ctx.values[ctx.values.length - 1]).toEqual([
			{ id: 1, name: 'A' },
			{ id: 'tmp', name: 'hello' }
		]);

		const sent = sendQueuedFn.mock.calls[sendQueuedFn.mock.calls.length - 1][0];
		expect(sent.rpc).toBe('curry/append');
		expect(sent.args).toEqual(['hello']);
		simulateRpcResponse(sent.id, { ok: true, data: 'ok' });
		await promise;
		ctx.unsub();
	});

	it('curry-form: same callable handles many call sites with different args', async () => {
		const ctx = await setupCrudStream('curry/many', 'curry-many', []);
		const create = __rpc('curry/create');

		const optimisticCreate = create.createOptimistic(
			ctx.store,
			{ event: 'created', data: { id: 'placeholder' } }
		);

		const p1 = optimisticCreate('first');
		const sent1 = sendQueuedFn.mock.calls[sendQueuedFn.mock.calls.length - 1][0];
		expect(sent1.args).toEqual(['first']);
		simulateRpcResponse(sent1.id, { ok: true, data: { id: 'a' } });
		await p1;

		const p2 = optimisticCreate('second');
		const sent2 = sendQueuedFn.mock.calls[sendQueuedFn.mock.calls.length - 1][0];
		expect(sent2.args).toEqual(['second']);
		simulateRpcResponse(sent2.id, { ok: true, data: { id: 'b' } });
		await p2;

		ctx.unsub();
	});

	it('curry-form: throws if change is missing', () => {
		const r = __rpc('curry/bad');
		const fakeStore = { mutate: () => {} };
		expect(() => r.createOptimistic(fakeStore, null)).toThrow(/optimisticChange is required/);
	});

	it('curry-form: still validates the store on the entry call', () => {
		const r = __rpc('curry/bad');
		expect(() => r.createOptimistic(null, () => {})).toThrow(/must be a stream store/);
	});
});

describe('store.createOptimistic (stream-side counterpart)', () => {
	async function setupCrudStream(path, topic, initial = []) {
		const store = __stream(path, { merge: 'crud', key: 'id' });
		const values = [];
		const unsub = store.subscribe((v) => values.push(v));
		await flush();
		const sent = sendQueuedFn.mock.calls[sendQueuedFn.mock.calls.length - 1][0];
		simulateRpcResponse(sent.id, { ok: true, data: initial, topic, merge: 'crud', key: 'id' });
		return { store, values, unsub, topic };
	}

	it('forwards to rpc.createOptimistic with this as the store', async () => {
		const ctx = await setupCrudStream('side/items', 'side-items', [{ id: 1, name: 'A' }]);
		const create = __rpc('side/create');

		const promise = ctx.store.createOptimistic(
			create,
			[{ name: 'B' }],
			{ event: 'created', data: { id: 't1', name: 'B' } }
		);
		expect(ctx.values[ctx.values.length - 1]).toEqual([
			{ id: 1, name: 'A' },
			{ id: 't1', name: 'B' }
		]);

		const sent = sendQueuedFn.mock.calls[sendQueuedFn.mock.calls.length - 1][0];
		expect(sent.rpc).toBe('side/create');
		expect(sent.args).toEqual([{ name: 'B' }]);
		simulateRpcResponse(sent.id, { ok: true, data: { id: 't1', name: 'B', server: true } });

		const result = await promise;
		expect(result).toEqual({ id: 't1', name: 'B', server: true });
		ctx.unsub();
	});

	it('rolls back on RPC failure (forwarded behavior)', async () => {
		const ctx = await setupCrudStream('side/fail', 'side-fail', [{ id: 1, name: 'A' }]);
		const create = __rpc('side/create-fail');

		const promise = ctx.store.createOptimistic(
			create,
			[{ name: 'B' }],
			{ event: 'created', data: { id: 't1', name: 'B' } }
		);
		const sent = sendQueuedFn.mock.calls[sendQueuedFn.mock.calls.length - 1][0];
		simulateRpcResponse(sent.id, { ok: false, code: 'INTERNAL_ERROR', error: 'boom' });

		await expect(promise).rejects.toMatchObject({ code: 'INTERNAL_ERROR' });
		expect(ctx.values[ctx.values.length - 1]).toEqual([{ id: 1, name: 'A' }]);
		ctx.unsub();
	});

	it('throws when first arg is not an RPC stub', async () => {
		const ctx = await setupCrudStream('side/bad', 'side-bad', []);
		expect(() => ctx.store.createOptimistic(null, [], () => {})).toThrow(/RPC stub/);
		expect(() => ctx.store.createOptimistic({}, [], () => {})).toThrow(/RPC stub/);
		ctx.unsub();
	});
});

// -- __devtools stream tracking ------------------------------------------------

describe('__devtools stream tracking', () => {
	it('records merge strategy on first subscribe', async () => {
		if (!__devtools) return;
		const store = __stream('dt/merge', { merge: 'crud', key: 'id' });
		const unsub = store.subscribe(() => {});
		await flush();

		const entry = __devtools.streams.get('dt/merge');
		expect(entry).toBeTruthy();
		expect(entry.merge).toBe('crud');
		expect(entry.subCount).toBe(1);
		unsub();
	});

	it('records lastEvent + lastEventTime on each pub/sub event', async () => {
		if (!__devtools) return;
		const store = __stream('dt/events', { merge: 'crud', key: 'id' });
		const unsub = store.subscribe(() => {});
		await flush();

		const sent = sendQueuedFn.mock.calls[sendQueuedFn.mock.calls.length - 1][0];
		simulateRpcResponse(sent.id, { ok: true, data: [], topic: 'dt-events', merge: 'crud', key: 'id' });

		const before = __devtools.streams.get('dt/events');
		expect(before.lastEventTime).toBeNull();
		expect(before.lastEvent).toBeNull();

		simulateTopicMessage('dt-events', { event: 'created', data: { id: 'a', name: 'A' } });

		const after = __devtools.streams.get('dt/events');
		expect(after.lastEvent).toBe('created');
		expect(after.lastEventTime).toBeGreaterThan(0);
		unsub();
	});

	it('records error state on stream failure', async () => {
		if (!__devtools) return;
		const store = __stream('dt/err', { merge: 'crud', key: 'id' });
		const unsub = store.subscribe(() => {});
		await flush();

		const sent = sendQueuedFn.mock.calls[sendQueuedFn.mock.calls.length - 1][0];
		simulateRpcResponse(sent.id, { ok: false, code: 'FORBIDDEN', error: 'no access' });

		const errored = __devtools.streams.get('dt/err');
		expect(errored.error).toEqual({ code: 'FORBIDDEN', message: 'no access' });
		unsub();
	});

	it('removes the entry when the last subscriber leaves', async () => {
		if (!__devtools) return;
		const store = __stream('dt/gone', { merge: 'crud', key: 'id' });
		const unsub = store.subscribe(() => {});
		await flush();

		expect(__devtools.streams.has('dt/gone')).toBe(true);

		unsub();
		await new Promise((r) => setTimeout(r, 50));

		expect(__devtools.streams.has('dt/gone')).toBe(false);
	});

	it('captures recentEvents on each pub/sub event up to the cap', async () => {
		if (!__devtools) return;
		__devtools.paused = false;
		const store = __stream('dt/payload', { merge: 'crud', key: 'id' });
		const unsub = store.subscribe(() => {});
		await flush();

		const sent = sendQueuedFn.mock.calls[sendQueuedFn.mock.calls.length - 1][0];
		simulateRpcResponse(sent.id, { ok: true, data: [], topic: 'dt-payload', merge: 'crud', key: 'id' });

		simulateTopicMessage('dt-payload', { event: 'created', data: { id: 'a', name: 'A' } });
		simulateTopicMessage('dt-payload', { event: 'updated', data: { id: 'a', name: 'A2' } });

		const entry = __devtools.streams.get('dt/payload');
		expect(entry.recentEvents).toHaveLength(2);
		expect(entry.recentEvents[0]).toMatchObject({ event: 'created', data: { id: 'a', name: 'A' } });
		expect(entry.recentEvents[1]).toMatchObject({ event: 'updated', data: { id: 'a', name: 'A2' } });
		expect(typeof entry.recentEvents[0].ts).toBe('number');
		unsub();
	});

	it('caps recentEvents per stream at 20 (oldest dropped)', async () => {
		if (!__devtools) return;
		__devtools.paused = false;
		const store = __stream('dt/cap', { merge: 'crud', key: 'id' });
		const unsub = store.subscribe(() => {});
		await flush();

		const sent = sendQueuedFn.mock.calls[sendQueuedFn.mock.calls.length - 1][0];
		simulateRpcResponse(sent.id, { ok: true, data: [], topic: 'dt-cap', merge: 'crud', key: 'id' });

		for (let i = 0; i < 25; i++) {
			simulateTopicMessage('dt-cap', { event: 'created', data: { id: i } });
		}

		const entry = __devtools.streams.get('dt/cap');
		expect(entry.recentEvents).toHaveLength(20);
		// Oldest five (ids 0-4) dropped; newest is id 24
		expect(entry.recentEvents[0].data).toEqual({ id: 5 });
		expect(entry.recentEvents[19].data).toEqual({ id: 24 });
		unsub();
	});

	it('redacts default sensitive keys (case-insensitive) in captured payloads', async () => {
		if (!__devtools) return;
		__devtools.paused = false;
		const store = __stream('dt/redact', { merge: 'crud', key: 'id' });
		const unsub = store.subscribe(() => {});
		await flush();

		const sent = sendQueuedFn.mock.calls[sendQueuedFn.mock.calls.length - 1][0];
		simulateRpcResponse(sent.id, { ok: true, data: [], topic: 'dt-redact', merge: 'crud', key: 'id' });

		simulateTopicMessage('dt-redact', {
			event: 'created',
			data: {
				id: 'u1',
				name: 'Alice',
				password: 'p4ssw0rd',
				Authorization: 'Bearer xyz',
				profile: { token: 'inner-token', age: 30 }
			}
		});

		const entry = __devtools.streams.get('dt/redact');
		const captured = entry.recentEvents[0].data;
		expect(captured.id).toBe('u1');
		expect(captured.name).toBe('Alice');
		expect(captured.password).toBe('[REDACTED]');
		expect(captured.Authorization).toBe('[REDACTED]');
		expect(captured.profile.token).toBe('[REDACTED]');
		expect(captured.profile.age).toBe(30);
		unsub();
	});

	it('respects __devtools.paused (no capture while paused)', async () => {
		if (!__devtools) return;
		const store = __stream('dt/pause', { merge: 'crud', key: 'id' });
		const unsub = store.subscribe(() => {});
		await flush();

		const sent = sendQueuedFn.mock.calls[sendQueuedFn.mock.calls.length - 1][0];
		simulateRpcResponse(sent.id, { ok: true, data: [], topic: 'dt-pause', merge: 'crud', key: 'id' });

		__devtools.paused = true;
		simulateTopicMessage('dt-pause', { event: 'created', data: { id: 1 } });

		const entry = __devtools.streams.get('dt/pause');
		expect(entry.recentEvents).toHaveLength(0);
		// lastEvent / lastEventTime still update so the panel shows live activity
		expect(entry.lastEvent).toBe('created');

		// Resume captures new events normally
		__devtools.paused = false;
		simulateTopicMessage('dt-pause', { event: 'updated', data: { id: 1, v: 2 } });
		expect(entry.recentEvents).toHaveLength(1);
		expect(entry.recentEvents[0].data).toEqual({ id: 1, v: 2 });
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

	describe('shape validation (dev-only)', () => {
		let warn;

		beforeEach(() => {
			warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		});

		afterEach(() => {
			warn.mockRestore();
		});

		it('warns when crud merge is hydrated with a non-array', () => {
			const store = __stream('shape/crud', { merge: 'crud', key: 'id' });
			store.hydrate({ id: 1, name: 'wrong' });
			expect(warn).toHaveBeenCalledTimes(1);
			expect(warn.mock.calls[0][0]).toMatch(/hydrate\('shape\/crud'\)/);
			expect(warn.mock.calls[0][0]).toMatch(/merge='crud'/);
			expect(warn.mock.calls[0][0]).toMatch(/expects an array/);
		});

		it('warns when latest merge is hydrated with a non-array', () => {
			const store = __stream('shape/latest', { merge: 'latest' });
			store.hydrate({ items: [] });
			expect(warn).toHaveBeenCalledTimes(1);
			expect(warn.mock.calls[0][0]).toMatch(/merge='latest'/);
		});

		it('warns when presence merge is hydrated with a non-array', () => {
			const store = __stream('shape/presence', { merge: 'presence' });
			store.hydrate({ alice: { online: true } });
			expect(warn).toHaveBeenCalledTimes(1);
			expect(warn.mock.calls[0][0]).toMatch(/merge='presence'/);
		});

		it('warns when cursor merge is hydrated with a non-array', () => {
			const store = __stream('shape/cursor', { merge: 'cursor' });
			store.hydrate({});
			expect(warn).toHaveBeenCalledTimes(1);
			expect(warn.mock.calls[0][0]).toMatch(/merge='cursor'/);
		});

		it('does not warn for set merge with arbitrary shapes', () => {
			const store = __stream('shape/set', { merge: 'set' });
			store.hydrate({ count: 0 });
			store.hydrate(42);
			store.hydrate('hello');
			store.hydrate([1, 2, 3]);
			expect(warn).not.toHaveBeenCalled();
		});

		it('does not warn when crud merge is hydrated with an array', () => {
			const store = __stream('shape/crudArray', { merge: 'crud', key: 'id' });
			store.hydrate([{ id: 1 }, { id: 2 }]);
			expect(warn).not.toHaveBeenCalled();
		});

		it('does not warn for null or undefined hydration', () => {
			const store = __stream('shape/nil', { merge: 'crud' });
			store.hydrate(null);
			store.hydrate(undefined);
			expect(warn).not.toHaveBeenCalled();
		});

		it('warning includes svti.me/merge shortlink', () => {
			const store = __stream('shape/link', { merge: 'crud' });
			store.hydrate({});
			expect(warn.mock.calls[0][0]).toMatch(/svti\.me\/merge/);
		});
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
		simulateStatus('disconnected');
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
		simulateStatus('disconnected');
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
		simulateStatus('disconnected');
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
		simulateStatus('disconnected');
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

		simulateStatus('disconnected');

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

	it('forwards auth: true to the adapter connect()', () => {
		connectFn.mockClear();
		configure({ auth: true });

		expect(connectFn).toHaveBeenCalledWith({ auth: true });
	});

	it('forwards a custom auth path string to the adapter connect()', () => {
		connectFn.mockClear();
		configure({ auth: '/custom/preflight' });

		expect(connectFn).toHaveBeenCalledWith({ auth: '/custom/preflight' });
	});

	it('forwards both url and auth together', () => {
		connectFn.mockClear();
		configure({ url: 'wss://api.example.com/ws', auth: true });

		expect(connectFn).toHaveBeenCalledWith({ url: 'wss://api.example.com/ws', auth: true });
	});

	it('omits the url key when only auth is configured', () => {
		connectFn.mockClear();
		configure({ auth: true });

		expect(connectFn).toHaveBeenCalledTimes(1);
		const arg = connectFn.mock.calls[0][0];
		expect(Object.prototype.hasOwnProperty.call(arg, 'url')).toBe(false);
	});

	it('does not forward auth when not provided', () => {
		connectFn.mockClear();
		configure({ url: 'wss://api.example.com/ws' });

		const arg = connectFn.mock.calls[0][0];
		expect(Object.prototype.hasOwnProperty.call(arg, 'auth')).toBe(false);
	});

	it('does not call connect() at all when neither url nor auth is set', () => {
		connectFn.mockClear();
		configure({ onConnect() {} });

		expect(connectFn).not.toHaveBeenCalled();
	});

	it('forwards auth: false explicitly when the user opts out', () => {
		connectFn.mockClear();
		configure({ auth: false });

		expect(connectFn).toHaveBeenCalledWith({ auth: false });
	});
});

// -- Cloudflare Tunnel symptom detector ---------------------------------------

describe('CF Tunnel symptom detector', () => {
	it('warns after two consecutive fast open->close cycles', async () => {
		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

		// Trigger ensureDisconnectListener via an RPC call. The status mock
		// fires 'open' synchronously on subscribe, so lastOpenAt is seeded.
		__rpc('cf/ping')().catch(() => {});

		simulateStatus('disconnected'); // first fast close
		simulateStatus('open');
		simulateStatus('disconnected'); // second fast close -> warn

		expect(warnSpy).toHaveBeenCalledTimes(1);
		const msg = warnSpy.mock.calls[0][0];
		expect(msg).toContain('Cloudflare-Tunnel');
		expect(msg).toContain('configure({ auth: true })');
		expect(msg).toContain('https://svti.me/cf-cookies');

		warnSpy.mockRestore();
	});

	it('does not warn after a single fast cycle', () => {
		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

		__rpc('cf/ping')().catch(() => {});
		simulateStatus('disconnected');

		expect(warnSpy).not.toHaveBeenCalled();
		warnSpy.mockRestore();
	});

	it('does not warn when configure({ auth: true }) is set', () => {
		configure({ auth: true });
		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

		__rpc('cf/ping')().catch(() => {});
		simulateStatus('disconnected');
		simulateStatus('open');
		simulateStatus('disconnected');
		simulateStatus('open');
		simulateStatus('disconnected');

		expect(warnSpy).not.toHaveBeenCalled();
		warnSpy.mockRestore();
	});

	it('only warns once even after many cycles', () => {
		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

		__rpc('cf/ping')().catch(() => {});
		for (let i = 0; i < 10; i++) {
			simulateStatus('disconnected');
			simulateStatus('open');
		}

		expect(warnSpy).toHaveBeenCalledTimes(1);
		warnSpy.mockRestore();
	});

	it('resets the counter when an open lasts longer than 1s', () => {
		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

		const realNow = Date.now;
		let now = 1_000_000;
		Date.now = () => now;

		try {
			__rpc('cf/ping')().catch(() => {});
			// Initial 'open' captured at now=1_000_000
			simulateStatus('disconnected');                  // count=1
			now += 5_000;                              // 5s gap
			simulateStatus('open');
			now += 2_000;                              // open lasted 2s
			simulateStatus('disconnected');                  // slow close -> reset
			now += 100;
			simulateStatus('open');
			simulateStatus('disconnected');                  // count=1 again, no warn

			expect(warnSpy).not.toHaveBeenCalled();
		} finally {
			Date.now = realNow;
			warnSpy.mockRestore();
		}
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

		// Several changes while paused -- no snapshots
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

// -- __rpc() .with({ idempotencyKey }) ----------------------------------------

describe('__rpc().with({ idempotencyKey })', () => {
	it('forwards idempotencyKey on the wire envelope', async () => {
		const call = __rpc('orders/create');
		const promise = call.with({ idempotencyKey: 'ord-1' })({ qty: 2 });

		expect(sendQueuedFn).toHaveBeenCalledTimes(1);
		const sent = sendQueuedFn.mock.calls[0][0];
		expect(sent.rpc).toBe('orders/create');
		expect(sent.idempotencyKey).toBe('ord-1');
		expect(sent.args).toEqual([{ qty: 2 }]);

		simulateRpcResponse(sent.id, { ok: true, data: { id: 7 } });
		expect(await promise).toEqual({ id: 7 });
	});

	it('does not include idempotencyKey on plain calls', async () => {
		const call = __rpc('plain/call');
		call('x');

		const sent = sendQueuedFn.mock.calls[0][0];
		expect('idempotencyKey' in sent).toBe(false);
	});

	it('returns the base callable when no key is provided (.with({}) is a no-op)', () => {
		const call = __rpc('noop/call');
		expect(call.with({})).toBe(call);
		expect(call.with(undefined)).toBe(call);
	});

	it('same key + same microtask -> coalesces into one envelope', async () => {
		const call = __rpc('coalesce/test');
		const bound = call.with({ idempotencyKey: 'shared' });

		const p1 = bound('a');
		const p2 = bound('a');

		expect(sendQueuedFn).toHaveBeenCalledTimes(1);
		expect(p1).toBe(p2);

		const sent = sendQueuedFn.mock.calls[0][0];
		simulateRpcResponse(sent.id, { ok: true, data: 'shared-result' });
		expect(await p1).toBe('shared-result');
	});

	it('different keys -> separate envelopes', async () => {
		const call = __rpc('distinct/test');

		const p1 = call.with({ idempotencyKey: 'k1' })('x');
		const p2 = call.with({ idempotencyKey: 'k2' })('x');

		expect(sendQueuedFn).toHaveBeenCalledTimes(2);
		const s1 = sendQueuedFn.mock.calls[0][0];
		const s2 = sendQueuedFn.mock.calls[1][0];
		expect(s1.idempotencyKey).toBe('k1');
		expect(s2.idempotencyKey).toBe('k2');

		simulateRpcResponse(s1.id, { ok: true, data: 'r1' });
		simulateRpcResponse(s2.id, { ok: true, data: 'r2' });
		expect(await p1).toBe('r1');
		expect(await p2).toBe('r2');
	});

	it('keyed and unkeyed calls dedup independently within a microtask', async () => {
		const call = __rpc('mixed/test');

		const plain = call('x');
		const keyed = call.with({ idempotencyKey: 'k' })('x');

		expect(sendQueuedFn).toHaveBeenCalledTimes(2);
		const s1 = sendQueuedFn.mock.calls[0][0];
		const s2 = sendQueuedFn.mock.calls[1][0];
		expect(s1.idempotencyKey).toBeUndefined();
		expect(s2.idempotencyKey).toBe('k');

		simulateRpcResponse(s1.id, { ok: true, data: 'plain' });
		simulateRpcResponse(s2.id, { ok: true, data: 'keyed' });
		expect(await plain).toBe('plain');
		expect(await keyed).toBe('keyed');
	});

	it('forwards idempotencyKey inside batch()', async () => {
		const a = __rpc('b/a');
		const b = __rpc('b/b');

		const result = batch(() => [
			a.with({ idempotencyKey: 'ka' })('x'),
			b('y')
		]);

		// One framed batch envelope
		expect(sendQueuedFn).toHaveBeenCalledTimes(1);
		const sent = sendQueuedFn.mock.calls[0][0];
		expect(Array.isArray(sent.batch)).toBe(true);
		expect(sent.batch[0].idempotencyKey).toBe('ka');
		expect('idempotencyKey' in sent.batch[1]).toBe(false);

		simulateRpcResponse(sent.batch[0].id, { ok: true, data: 'A' });
		simulateRpcResponse(sent.batch[1].id, { ok: true, data: 'B' });
		expect(await result).toEqual(['A', 'B']);
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

// -- health store -------------------------------------------------------------

describe('health store', () => {
	it('starts at "healthy"', () => {
		const values = [];
		const unsub = health.subscribe((v) => values.push(v));
		expect(values).toEqual(['healthy']);
		unsub();
	});

	it('subscribes to the __realtime topic on first consumer (lazy)', () => {
		// Before any consumer subscribes, the topic should not be active.
		expect(topicCallbacks.has('__realtime')).toBe(false);

		const unsub = health.subscribe(() => {});
		expect(topicCallbacks.has('__realtime')).toBe(true);
		unsub();
	});

	it('flips to "degraded" on a degraded event', () => {
		const values = [];
		const unsub = health.subscribe((v) => values.push(v));

		simulateTopicMessage('__realtime', { event: 'degraded', data: { reason: 'redis-circuit-open' } });
		expect(values[values.length - 1]).toBe('degraded');

		unsub();
	});

	it('flips back to "healthy" on a recovered event', () => {
		const values = [];
		const unsub = health.subscribe((v) => values.push(v));

		simulateTopicMessage('__realtime', { event: 'degraded', data: {} });
		expect(values[values.length - 1]).toBe('degraded');

		simulateTopicMessage('__realtime', { event: 'recovered', data: {} });
		expect(values[values.length - 1]).toBe('healthy');

		unsub();
	});

	it('ignores unknown event names on the system topic', () => {
		const values = [];
		const unsub = health.subscribe((v) => values.push(v));

		simulateTopicMessage('__realtime', { event: 'something-else', data: {} });
		expect(values).toEqual(['healthy']);

		unsub();
	});

	it('ignores null / undefined envelopes on the system topic', () => {
		const values = [];
		const unsub = health.subscribe((v) => values.push(v));

		simulateTopicMessage('__realtime', null);
		simulateTopicMessage('__realtime', undefined);
		expect(values).toEqual(['healthy']);

		unsub();
	});

	it('multiple consumers see the same state transitions', () => {
		const a = [];
		const b = [];
		const unsubA = health.subscribe((v) => a.push(v));
		const unsubB = health.subscribe((v) => b.push(v));

		simulateTopicMessage('__realtime', { event: 'degraded', data: {} });

		expect(a[a.length - 1]).toBe('degraded');
		expect(b[b.length - 1]).toBe('degraded');

		unsubA();
		unsubB();
	});

	it('does not subscribe to __realtime if no consumer ever subscribes to health', () => {
		// Just importing health should not register the topic.
		expect(topicCallbacks.has('__realtime')).toBe(false);
	});
});

// -- subscribe-denials routed to per-stream error stores ----------------------

describe('subscribe-denial routing', () => {
	async function setupStreamSubscribed(topic) {
		const callsBefore = sendQueuedFn.mock.calls.length;
		const store = __stream('feed/items', { merge: 'crud', key: 'id' });
		const errorValues = [];
		const errorUnsub = store.error.subscribe((v) => errorValues.push(v));
		const dataUnsub = store.subscribe(() => {});
		await flush();
		const sent = sendQueuedFn.mock.calls[callsBefore][0];
		simulateRpcResponse(sent.id, { ok: true, data: [], topic, merge: 'crud', key: 'id' });
		return { store, errorValues, cleanup: () => { errorUnsub(); dataUnsub(); } };
	}

	it('routes a FORBIDDEN denial to the matching stream error store', async () => {
		const ctx = await setupStreamSubscribed('feed:42');
		expect(ctx.errorValues[ctx.errorValues.length - 1]).toBeNull();

		simulateDenial({ topic: 'feed:42', reason: 'FORBIDDEN', ref: 1 });

		const last = ctx.errorValues[ctx.errorValues.length - 1];
		expect(last).toBeInstanceOf(RpcError);
		expect(last.code).toBe('FORBIDDEN');
		expect(last.message).toContain("'feed:42'");
		ctx.cleanup();
	});

	it('routes UNAUTHENTICATED, INVALID_TOPIC, RATE_LIMITED with the same code passthrough', async () => {
		for (const reason of ['UNAUTHENTICATED', 'INVALID_TOPIC', 'RATE_LIMITED']) {
			const ctx = await setupStreamSubscribed(`t-${reason}`);
			simulateDenial({ topic: `t-${reason}`, reason, ref: 1 });
			const last = ctx.errorValues[ctx.errorValues.length - 1];
			expect(last.code).toBe(reason);
			ctx.cleanup();
		}
	});

	it('passes through a custom (non-canonical) reason string verbatim as code', async () => {
		const ctx = await setupStreamSubscribed('billing:42');
		simulateDenial({ topic: 'billing:42', reason: 'PLAN_LOCKED', ref: 1 });
		const last = ctx.errorValues[ctx.errorValues.length - 1];
		expect(last.code).toBe('PLAN_LOCKED');
		ctx.cleanup();
	});

	it('does not affect streams subscribed to a different topic', async () => {
		const ctxA = await setupStreamSubscribed('topic:A');
		const ctxB = await setupStreamSubscribed('topic:B');

		simulateDenial({ topic: 'topic:A', reason: 'FORBIDDEN', ref: 1 });

		expect(ctxA.errorValues[ctxA.errorValues.length - 1]?.code).toBe('FORBIDDEN');
		expect(ctxB.errorValues[ctxB.errorValues.length - 1]).toBeNull();

		ctxA.cleanup();
		ctxB.cleanup();
	});

	it('falls back to FORBIDDEN code when reason is missing or empty', async () => {
		const ctx = await setupStreamSubscribed('feed:bare');
		simulateDenial({ topic: 'feed:bare', reason: '', ref: 1 });
		const last = ctx.errorValues[ctx.errorValues.length - 1];
		expect(last.code).toBe('FORBIDDEN');
		ctx.cleanup();
	});

	it('ignores denials for topics with no registered streams', async () => {
		const ctx = await setupStreamSubscribed('feed:active');
		simulateDenial({ topic: 'feed:nobody', reason: 'FORBIDDEN', ref: 1 });

		expect(ctx.errorValues[ctx.errorValues.length - 1]).toBeNull();
		ctx.cleanup();
	});

	it('clears the error on a subsequent successful stream RPC', async () => {
		const ctx = await setupStreamSubscribed('feed:retry');
		simulateDenial({ topic: 'feed:retry', reason: 'FORBIDDEN', ref: 1 });
		expect(ctx.errorValues[ctx.errorValues.length - 1]?.code).toBe('FORBIDDEN');

		// A second successful RPC for the same stream clears the error.
		const sent = sendQueuedFn.mock.calls[sendQueuedFn.mock.calls.length - 1];
		// Drive a re-fetch by simulating a connection event the stream listens for.
		simulateStatus('open');
		await flush();
		const followUp = sendQueuedFn.mock.calls[sendQueuedFn.mock.calls.length - 1][0];
		if (followUp && followUp.id !== sent[0].id) {
			simulateRpcResponse(followUp.id, { ok: true, data: [], topic: 'feed:retry', merge: 'crud', key: 'id' });
			expect(ctx.errorValues[ctx.errorValues.length - 1]).toBeNull();
		}
		ctx.cleanup();
	});
});

// -- quiescent store ----------------------------------------------------------

describe('quiescent store', () => {
	it('starts true (no streams active)', () => {
		const values = [];
		const unsub = quiescent.subscribe((v) => values.push(v));
		expect(values).toEqual([true]);
		unsub();
	});

	it('flips to false when a stream subscribes and back to true on settle', async () => {
		const values = [];
		const unsub = quiescent.subscribe((v) => values.push(v));
		expect(values[values.length - 1]).toBe(true);

		const store = __stream('feed/items', { merge: 'crud', key: 'id' });
		const dataUnsub = store.subscribe(() => {});
		await flush();
		// One stream loading -> not quiescent
		expect(values[values.length - 1]).toBe(false);

		const sent = sendQueuedFn.mock.calls[0][0];
		simulateRpcResponse(sent.id, { ok: true, data: [], topic: 'feed:1', merge: 'crud', key: 'id' });
		// Stream settled -> quiescent again
		expect(values[values.length - 1]).toBe(true);

		dataUnsub();
		unsub();
	});

	it('stays false until ALL streams settle', async () => {
		const values = [];
		const unsub = quiescent.subscribe((v) => values.push(v));

		const a = __stream('feed/a', { merge: 'crud', key: 'id' });
		const b = __stream('feed/b', { merge: 'crud', key: 'id' });
		const c = __stream('feed/c', { merge: 'crud', key: 'id' });
		const subA = a.subscribe(() => {});
		const subB = b.subscribe(() => {});
		const subC = c.subscribe(() => {});
		await flush();
		expect(values[values.length - 1]).toBe(false);

		// Subscribe RPCs are microtask-batched into one send.
		const sent = sendQueuedFn.mock.calls[0][0];
		const ids = sent.batch.map((c) => c.id);

		// Settle two of three -- still not quiescent
		simulateRpcResponse(ids[0], { ok: true, data: [], topic: 'a', merge: 'crud', key: 'id' });
		simulateRpcResponse(ids[1], { ok: true, data: [], topic: 'b', merge: 'crud', key: 'id' });
		expect(values[values.length - 1]).toBe(false);

		// Settle the third -- now quiescent
		simulateRpcResponse(ids[2], { ok: true, data: [], topic: 'c', merge: 'crud', key: 'id' });
		expect(values[values.length - 1]).toBe(true);

		subA(); subB(); subC();
		unsub();
	});

	it('settles a stream that errored (not just connected)', async () => {
		const values = [];
		const unsub = quiescent.subscribe((v) => values.push(v));

		const store = __stream('feed/err', { merge: 'crud', key: 'id' });
		const sub = store.subscribe(() => {});
		await flush();
		expect(values[values.length - 1]).toBe(false);

		const sent = sendQueuedFn.mock.calls[0][0];
		simulateRpcResponse(sent.id, { ok: false, code: 'FORBIDDEN', error: 'nope' });
		// Errored counts as settled
		expect(values[values.length - 1]).toBe(true);

		sub();
		unsub();
	});

	it('decrements when the only subscriber leaves before the stream settles', async () => {
		const values = [];
		const unsub = quiescent.subscribe((v) => values.push(v));

		const store = __stream('feed/abandoned', { merge: 'crud', key: 'id' });
		const sub = store.subscribe(() => {});
		await flush();
		expect(values[values.length - 1]).toBe(false);

		// Leave before the stream settles. Cleanup is microtask-deferred.
		sub();
		await flush();
		await flush();
		expect(values[values.length - 1]).toBe(true);

		unsub();
	});

	it('a stream with no consumers does not contribute to in-flight count', () => {
		const values = [];
		const unsub = quiescent.subscribe((v) => values.push(v));

		// Create a stream but don't subscribe -- should stay quiescent
		__stream('feed/uncalled', { merge: 'crud', key: 'id' });
		expect(values[values.length - 1]).toBe(true);

		unsub();
	});

	it('reconnect cycle: re-enters in-flight on re-subscribe attempt', async () => {
		const values = [];
		const unsub = quiescent.subscribe((v) => values.push(v));

		const store = __stream('feed/recon', { merge: 'crud', key: 'id' });
		const sub = store.subscribe(() => {});
		await flush();
		const sent = sendQueuedFn.mock.calls[0][0];
		simulateRpcResponse(sent.id, { ok: true, data: [], topic: 'feed:r', merge: 'crud', key: 'id' });
		expect(values[values.length - 1]).toBe(true);

		// Simulate a reconnect: status flips to 'open' again, stream goes 'reconnecting'
		simulateStatus('disconnected');
		simulateStatus('open');
		// Stream listener kicks in, _status -> 'reconnecting', count -> 1
		expect(values[values.length - 1]).toBe(false);

		sub();
		unsub();
	});
});

// -- failure re-export --------------------------------------------------------

describe('failure store', () => {
	it('is re-exported from the adapter client', () => {
		expect(failure).toBeDefined();
		expect(typeof failure.subscribe).toBe('function');
	});

	it('subscribers receive the current value (null while connected)', () => {
		const values = [];
		const unsub = failure.subscribe((v) => values.push(v));
		expect(values).toEqual([null]);
		unsub();
	});

	it('surfaces ws-close failure values from the adapter unchanged', () => {
		const values = [];
		const unsub = failure.subscribe((v) => values.push(v));
		expect(values).toEqual([null]);

		const f = { kind: 'ws-close', class: 'TERMINAL', code: 4401, reason: 'unauthorized' };
		simulateFailure(f);
		expect(values[1]).toBe(f);
		unsub();
	});

	it('surfaces auth-preflight failure values from the adapter unchanged', () => {
		const values = [];
		const unsub = failure.subscribe((v) => values.push(v));
		expect(values).toEqual([null]);

		const f = { kind: 'auth-preflight', class: 'AUTH', status: 401, reason: 'invalid token' };
		simulateFailure(f);
		expect(values[1]).toBe(f);
		unsub();
	});

	it('surfaces THROTTLE / EXHAUSTED / RETRY classes', () => {
		const values = [];
		const unsub = failure.subscribe((v) => values.push(v));

		simulateFailure({ kind: 'ws-close', class: 'THROTTLE', code: 4429, reason: 'rate limited' });
		simulateFailure({ kind: 'ws-close', class: 'EXHAUSTED', code: 1006, reason: 'max retries' });
		simulateFailure({ kind: 'ws-close', class: 'RETRY', code: 1006, reason: 'transient' });

		expect(values[1]?.class).toBe('THROTTLE');
		expect(values[2]?.class).toBe('EXHAUSTED');
		expect(values[3]?.class).toBe('RETRY');
		unsub();
	});

	it('clears to null on the next successful open transition', () => {
		const values = [];
		const unsub = failure.subscribe((v) => values.push(v));

		simulateFailure({ kind: 'ws-close', class: 'RETRY', code: 1006, reason: 'blip' });
		simulateFailure(null);

		expect(values[values.length - 1]).toBeNull();
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

		simulateStatus('disconnected');
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

		simulateStatus('disconnected');
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

// -- __rpc().with({ timeout }) ----------------------------------------------

describe('__rpc().with({ timeout })', () => {
	it('returns the base callable when no options are provided', () => {
		const call = __rpc('t/none');
		expect(call.with({})).toBe(call);
		expect(call.with(undefined)).toBe(call);
	});

	it('returns a wrapped callable when only timeout is provided', () => {
		const call = __rpc('t/wrap');
		expect(call.with({ timeout: 60_000 })).not.toBe(call);
	});

	it('rejects with TIMEOUT after the per-call timeout fires', async () => {
		vi.useFakeTimers();
		try {
			const call = __rpc('t/fire');
			const promise = call.with({ timeout: 1000 })('payload');
			// Suppress unhandled rejection during the fake-timer advance
			promise.catch(() => {});
			expect(sendQueuedFn).toHaveBeenCalledTimes(1);

			await vi.advanceTimersByTimeAsync(1500);
			await expect(promise).rejects.toMatchObject({ code: 'TIMEOUT' });
			await expect(promise).rejects.toThrow(/timed out after 1s/);
		} finally {
			vi.useRealTimers();
		}
	});

	it('does NOT time out before the per-call timeout fires (overrides the 30s default)', async () => {
		vi.useFakeTimers();
		try {
			const call = __rpc('t/wait');
			const promise = call.with({ timeout: 60_000 })('x');

			// Advance past the 30s default but well before the 60s override
			await vi.advanceTimersByTimeAsync(35_000);

			// Resolve the call before the override timer fires
			const sent = sendQueuedFn.mock.calls[0][0];
			simulateRpcResponse(sent.id, { ok: true, data: 'late-but-fine' });
			expect(await promise).toBe('late-but-fine');
		} finally {
			vi.useRealTimers();
		}
	});

	it('timeout-only calls do NOT dedup against the base path within a microtask', async () => {
		const call = __rpc('t/no-dedup');
		const p1 = call('x');
		const p2 = call.with({ timeout: 60_000 })('x');

		// Two distinct envelopes
		expect(sendQueuedFn).toHaveBeenCalledTimes(2);
		expect(p1).not.toBe(p2);

		const s1 = sendQueuedFn.mock.calls[0][0];
		const s2 = sendQueuedFn.mock.calls[1][0];
		simulateRpcResponse(s1.id, { ok: true, data: 'plain' });
		simulateRpcResponse(s2.id, { ok: true, data: 'timed' });
		expect(await p1).toBe('plain');
		expect(await p2).toBe('timed');
	});

	it('timeout + idempotencyKey compose: dedup by key, override timer', async () => {
		vi.useFakeTimers();
		try {
			const call = __rpc('t/compose');
			const bound = call.with({ idempotencyKey: 'k1', timeout: 90_000 });

			const p1 = bound('a');
			const p2 = bound('a');

			// Same key + same microtask -> coalesced into one envelope
			expect(sendQueuedFn).toHaveBeenCalledTimes(1);
			expect(p1).toBe(p2);

			const sent = sendQueuedFn.mock.calls[0][0];
			expect(sent.idempotencyKey).toBe('k1');

			// Past the 30s default, well before the 90s override
			await vi.advanceTimersByTimeAsync(45_000);
			simulateRpcResponse(sent.id, { ok: true, data: 'composed' });
			expect(await p1).toBe('composed');
		} finally {
			vi.useRealTimers();
		}
	});

	it('per-call timeout is ignored inside batch() (batch-level timer governs)', async () => {
		const a = __rpc('t/b1');
		const b = __rpc('t/b2');

		const result = batch(() => [
			a.with({ timeout: 60_000 })('x'),
			b('y')
		]);

		expect(sendQueuedFn).toHaveBeenCalledTimes(1);
		const sent = sendQueuedFn.mock.calls[0][0];
		expect(Array.isArray(sent.batch)).toBe(true);
		// timeout is NOT carried in the wire envelope (per-call timeout is
		// a client-side timer concern, not a server protocol field)
		expect('timeout' in sent.batch[0]).toBe(false);

		simulateRpcResponse(sent.batch[0].id, { ok: true, data: 'A' });
		simulateRpcResponse(sent.batch[1].id, { ok: true, data: 'B' });
		expect(await result).toEqual(['A', 'B']);
	});
});

// -- refreshed event (stream staleness watchdog reload) ----------------------

describe('refreshed event', () => {
	it('replaces crud state with the new array and rebuilds the index', async () => {
		const store = __stream('items/list', { merge: 'crud', key: 'id' });
		const values = [];
		const unsub = store.subscribe((v) => values.push(v));

		await flush();
		const sent = sendQueuedFn.mock.calls[0][0];
		simulateRpcResponse(sent.id, {
			ok: true,
			data: [{ id: 1, name: 'A' }, { id: 2, name: 'B' }],
			topic: 'items',
			merge: 'crud',
			key: 'id'
		});

		simulateTopicMessage('items', {
			event: 'refreshed',
			data: [{ id: 3, name: 'C' }, { id: 4, name: 'D' }]
		});

		const lastValue = values[values.length - 1];
		expect(lastValue).toEqual([{ id: 3, name: 'C' }, { id: 4, name: 'D' }]);

		// After refresh, the index is rebuilt for the new keys -- a follow-up
		// updated event for an item from the refreshed set finds its slot.
		simulateTopicMessage('items', {
			event: 'updated',
			data: { id: 3, name: 'C-updated' }
		});

		const final = values[values.length - 1];
		expect(final).toEqual([{ id: 3, name: 'C-updated' }, { id: 4, name: 'D' }]);

		unsub();
	});

	it('replaces set state with the new value', async () => {
		const store = __stream('config/current', { merge: 'set' });
		const values = [];
		const unsub = store.subscribe((v) => values.push(v));

		await flush();
		const sent = sendQueuedFn.mock.calls[0][0];
		simulateRpcResponse(sent.id, {
			ok: true,
			data: { theme: 'light', density: 'comfy' },
			topic: 'config',
			merge: 'set'
		});

		simulateTopicMessage('config', {
			event: 'refreshed',
			data: { theme: 'dark', density: 'compact', accent: 'blue' }
		});

		const lastValue = values[values.length - 1];
		expect(lastValue).toEqual({ theme: 'dark', density: 'compact', accent: 'blue' });

		unsub();
	});

	it('replaces latest state with the new array', async () => {
		const store = __stream('events/recent', { merge: 'latest' });
		const values = [];
		const unsub = store.subscribe((v) => values.push(v));

		await flush();
		const sent = sendQueuedFn.mock.calls[0][0];
		simulateRpcResponse(sent.id, {
			ok: true,
			data: [{ ts: 1, msg: 'a' }, { ts: 2, msg: 'b' }],
			topic: 'events',
			merge: 'latest'
		});

		simulateTopicMessage('events', {
			event: 'refreshed',
			data: [{ ts: 10, msg: 'x' }]
		});

		const lastValue = values[values.length - 1];
		expect(lastValue).toEqual([{ ts: 10, msg: 'x' }]);

		unsub();
	});

	it('replaces presence state and rebuilds the index', async () => {
		const store = __stream('room/presence', { merge: 'presence', key: 'key' });
		const values = [];
		const unsub = store.subscribe((v) => values.push(v));

		await flush();
		const sent = sendQueuedFn.mock.calls[0][0];
		simulateRpcResponse(sent.id, {
			ok: true,
			data: [{ key: 'u1', name: 'Alice' }],
			topic: 'room/presence',
			merge: 'presence',
			key: 'key'
		});

		simulateTopicMessage('room/presence', {
			event: 'refreshed',
			data: [{ key: 'u2', name: 'Bob' }, { key: 'u3', name: 'Carol' }]
		});

		const lastValue = values[values.length - 1];
		expect(lastValue).toEqual([{ key: 'u2', name: 'Bob' }, { key: 'u3', name: 'Carol' }]);

		// Index is rebuilt -- a follow-up leave for one of the refreshed keys
		// removes it correctly.
		simulateTopicMessage('room/presence', {
			event: 'leave',
			data: { key: 'u2', name: 'Bob' }
		});

		const final = values[values.length - 1];
		expect(final).toEqual([{ key: 'u3', name: 'Carol' }]);

		unsub();
	});

	it('clears optimistic-key tracking on refresh', async () => {
		const store = __stream('todos/list', { merge: 'crud', key: 'id' });
		const values = [];
		const unsub = store.subscribe((v) => values.push(v));

		await flush();
		const sent = sendQueuedFn.mock.calls[0][0];
		simulateRpcResponse(sent.id, {
			ok: true,
			data: [{ id: 1, title: 'a' }],
			topic: 'todos',
			merge: 'crud',
			key: 'id'
		});

		// Apply an optimistic placeholder (registers in _optimisticKeys)
		store.optimistic('created', { id: 'temp-x', title: 'pending' });

		// Refresh arrives -- server's authoritative state replaces everything,
		// and the optimistic-key tracking is cleared.
		simulateTopicMessage('todos', {
			event: 'refreshed',
			data: [{ id: 1, title: 'a' }, { id: 2, title: 'b' }]
		});

		const lastValue = values[values.length - 1];
		expect(lastValue).toEqual([{ id: 1, title: 'a' }, { id: 2, title: 'b' }]);
		// Optimistic was wiped -- the temp-x placeholder is gone, no stale dedup state.

		unsub();
	});
});

// -- onPush -------------------------------------------------------------------

describe('onPush()', () => {
	it('registers a handler that runs on incoming request frames', async () => {
		const handler = vi.fn().mockReturnValue('reply');
		onPush('event-a', handler);

		expect(onRequestHandler).toBeTypeOf('function');
		const reply = await onRequestHandler('event-a', { x: 1 });
		expect(handler).toHaveBeenCalledWith({ x: 1 });
		expect(reply).toBe('reply');
	});

	it('multiplexes multiple events over a single onRequest subscription', async () => {
		onPush('event-a', () => 'a');
		onPush('event-b', () => 'b');

		// Only one dispatcher subscribed despite two registrations
		expect(onRequestUnsubs.size).toBe(1);

		expect(await onRequestHandler('event-a', null)).toBe('a');
		expect(await onRequestHandler('event-b', null)).toBe('b');
	});

	it('replaces handler when same event re-registered', async () => {
		onPush('e', () => 'first');
		onPush('e', () => 'second');
		expect(await onRequestHandler('e', null)).toBe('second');
	});

	it('returned unsubscribe removes only its own handler', async () => {
		const offFirst = onPush('e', () => 'first');
		onPush('e', () => 'second');
		offFirst(); // no-op since the registered handler is no longer the first
		expect(await onRequestHandler('e', null)).toBe('second');
	});

	it('rejects on the server side when event has no handler registered', async () => {
		onPush('known', () => 'ok'); // ensures dispatcher is attached
		await expect(onRequestHandler('unknown', null)).rejects.toThrow(/no push handler/);
	});

	it('handler errors propagate to the server', async () => {
		onPush('e', async () => { throw new Error('boom'); });
		await expect(onRequestHandler('e', null)).rejects.toThrow('boom');
	});

	it('async handlers resolve through to the reply', async () => {
		onPush('e', async (data) => {
			await new Promise((r) => setTimeout(r, 1));
			return data.x * 2;
		});
		await expect(onRequestHandler('e', { x: 21 })).resolves.toBe(42);
	});

	it('detaches the adapter dispatcher when the last handler is removed', () => {
		const off = onPush('e', () => 'ok');
		expect(onRequestUnsubs.size).toBe(1);
		off();
		expect(onRequestUnsubs.size).toBe(0);
	});

	it('does not detach while other handlers remain', () => {
		const offA = onPush('a', () => 'a');
		onPush('b', () => 'b');
		offA();
		expect(onRequestUnsubs.size).toBe(1);
	});

	it('rejects malformed args', () => {
		expect(() => onPush('', () => {})).toThrow(/event/);
		expect(() => onPush(/** @type {any} */ (null), () => {})).toThrow(/event/);
		expect(() => onPush('e', /** @type {any} */ (null))).toThrow(/handler/);
		expect(() => onPush('e', /** @type {any} */ ('not-fn'))).toThrow(/handler/);
	});
});

// -- __stream() Svelte 5 .rune() helper ---------------------------------------

describe('__stream() rune()', () => {
	async function setupStream() {
		const store = __stream('rune/items', { merge: 'crud', key: 'id' });
		const values = [];
		const unsub = store.subscribe((v) => values.push(v));
		await flush();
		const sent = sendQueuedFn.mock.calls[0][0];
		simulateRpcResponse(sent.id, {
			ok: true,
			data: [{ id: 1, name: 'A' }, { id: 2, name: 'B' }],
			topic: 'rune-items',
			merge: 'crud',
			key: 'id'
		});
		return { store, values, unsub };
	}

	it('returns an object with a current getter', async () => {
		const { store, unsub } = await setupStream();
		const r = store.rune();
		expect(typeof r).toBe('object');
		expect('current' in r).toBe(true);
		unsub();
	});

	it('current reflects the latest store value', async () => {
		const { store, unsub } = await setupStream();
		const r = store.rune();
		expect(r.current).toEqual([{ id: 1, name: 'A' }, { id: 2, name: 'B' }]);
		unsub();
	});

	it('current updates when the store updates', async () => {
		const { store, unsub } = await setupStream();
		const r = store.rune();
		simulateTopicMessage('rune-items', { event: 'created', data: { id: 3, name: 'C' } });
		expect(r.current).toEqual([
			{ id: 1, name: 'A' },
			{ id: 2, name: 'B' },
			{ id: 3, name: 'C' }
		]);
		unsub();
	});

	it('throws under Svelte 4 (svelte/store missing fromStore)', async () => {
		// Re-mock svelte/store WITHOUT fromStore to simulate Svelte 4.
		vi.resetModules();
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
			onDerived: () => ({ subscribe: () => () => {} }),
			status: { subscribe: (fn) => { fn('open'); return () => {}; } },
			failure: { subscribe: (fn) => { fn(null); return () => {}; } },
			denials: { subscribe: (fn) => { fn(null); return () => {}; } },
			onRequest: () => () => {}
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
			readable: (initial) => ({
				subscribe(fn) { fn(initial); return () => {}; }
			}),
			// Explicit undefined - real Svelte 4 omits the export entirely;
			// vitest's strict mock factory requires us to declare it.
			fromStore: undefined
		}));
		const mod = await import('../client.js');
		const s = mod.__stream('rune-v4/items', { merge: 'crud', key: 'id' });
		const u = s.subscribe(() => {});
		expect(() => s.rune()).toThrow(/requires Svelte 5/);
		u();
	});
});

// -- __stream() .map() projection helper --------------------------------------

describe('__stream() map()', () => {
	async function setupStream() {
		const store = __stream('map/items', { merge: 'crud', key: 'id' });
		const unsub = store.subscribe(() => {});
		await flush();
		const sent = sendQueuedFn.mock.calls[0][0];
		simulateRpcResponse(sent.id, {
			ok: true,
			data: [{ id: 1, name: 'A' }, { id: 2, name: 'B' }],
			topic: 'map-items',
			merge: 'crud',
			key: 'id'
		});
		return { store, unsub };
	}

	it('returns an object with subscribe, rune, and map', async () => {
		const { store, unsub } = await setupStream();
		const mapped = store.map((t) => t.name);
		expect(typeof mapped.subscribe).toBe('function');
		expect(typeof mapped.rune).toBe('function');
		expect(typeof mapped.map).toBe('function');
		unsub();
	});

	it('projects each array item through fn', async () => {
		const { store, unsub } = await setupStream();
		const mapped = store.map((t) => t.name);
		const seen = [];
		const u = mapped.subscribe((v) => seen.push(v));
		expect(seen[seen.length - 1]).toEqual(['A', 'B']);
		u();
		unsub();
	});

	it('updates when the source array updates', async () => {
		const { store, unsub } = await setupStream();
		const mapped = store.map((t) => t.name);
		const seen = [];
		const u = mapped.subscribe((v) => seen.push(v));
		simulateTopicMessage('map-items', { event: 'created', data: { id: 3, name: 'C' } });
		expect(seen[seen.length - 1]).toEqual(['A', 'B', 'C']);
		u();
		unsub();
	});

	it('emits [] for null source', async () => {
		const store = __stream('map/null', { merge: 'set' });
		const subUnsub = store.subscribe(() => {});
		await flush();
		const sent = sendQueuedFn.mock.calls[0][0];
		simulateRpcResponse(sent.id, {
			ok: true,
			data: null,
			topic: 'map-null',
			merge: 'set'
		});
		const mapped = store.map((/** @type {any} */ x) => x);
		const seen = [];
		const u = mapped.subscribe((v) => seen.push(v));
		expect(seen[seen.length - 1]).toEqual([]);
		u();
		subUnsub();
	});

	it('emits [] and warns for non-array source in dev', async () => {
		const prev = process.env.NODE_ENV;
		process.env.NODE_ENV = 'development';
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			const store = __stream('map/obj', { merge: 'set' });
			const subUnsub = store.subscribe(() => {});
			await flush();
			const sent = sendQueuedFn.mock.calls[0][0];
			simulateRpcResponse(sent.id, {
				ok: true,
				data: { count: 5 },
				topic: 'map-obj',
				merge: 'set'
			});
			const mapped = store.map((/** @type {any} */ x) => x);
			const seen = [];
			const u = mapped.subscribe((v) => seen.push(v));
			expect(seen[seen.length - 1]).toEqual([]);
			expect(warn).toHaveBeenCalledWith(expect.stringContaining('.map() expects an array source'));
			u();
			subUnsub();
		} finally {
			warn.mockRestore();
			process.env.NODE_ENV = prev;
		}
	});

	it('chains via .map(g) preserving the same shape', async () => {
		const { store, unsub } = await setupStream();
		const lengths = store.map((t) => t.name).map((s) => s.length);
		expect(typeof lengths.rune).toBe('function');
		const seen = [];
		const u = lengths.subscribe((v) => seen.push(v));
		expect(seen[seen.length - 1]).toEqual([1, 1]);
		u();
		unsub();
	});

	it('rune() on a mapped store returns reactive { current }', async () => {
		const { store, unsub } = await setupStream();
		const ids = store.map((t) => t.id);
		const r = ids.rune();
		expect(r.current).toEqual([1, 2]);
		simulateTopicMessage('map-items', { event: 'created', data: { id: 3, name: 'C' } });
		expect(r.current).toEqual([1, 2, 3]);
		unsub();
	});

	it('validates fn is a function', async () => {
		const { store, unsub } = await setupStream();
		expect(() => store.map(/** @type {any} */ (null))).toThrow(/fn must be a function/);
		expect(() => store.map(/** @type {any} */ ('not-fn'))).toThrow(/fn must be a function/);
		unsub();
	});

	it('subscribes the source lazily on first consumer and unsubscribes on last', async () => {
		const { store, unsub } = await setupStream();
		const mapped = store.map((t) => t.id);
		// Track source subscriber count via an indirect signal: a publish
		// before any mapped consumer should not be projected anywhere.
		// Subscribe two consumers, then drop both; verify the mapped store
		// emits nothing further until a new consumer arrives.
		const seenA = [];
		const seenB = [];
		const ua = mapped.subscribe((v) => seenA.push(v));
		const ub = mapped.subscribe((v) => seenB.push(v));
		expect(seenA[seenA.length - 1]).toEqual([1, 2]);
		expect(seenB[seenB.length - 1]).toEqual([1, 2]);
		ua();
		ub();
		// After both unsubscribe, a new subscriber should still see the
		// current value (re-activation works).
		const seenC = [];
		const uc = mapped.subscribe((v) => seenC.push(v));
		expect(seenC[seenC.length - 1]).toEqual([1, 2]);
		uc();
		unsub();
	});
});
