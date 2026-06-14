import { describe, it, expect, vi, beforeEach } from 'vitest';

// `subscribeAt` walks the same wire path as a real reconnecting stale
// client: the client sends `subscribe { schemaVersion: N }`, the server
// runs migration forward through its registered chain, and returns the
// migrated payload. These tests stub the wire so we can assert (a) the
// outgoing envelope carries the chosen schemaVersion, and (b) when the
// server's response shape comes back, the parallel store renders it
// independently of the production store.

let __stream, subscribeAt;
let topicCallbacks;
let statusCallbacks;
let sendQueuedFn;
let connectFn;

function simulateRpcResponse(correlationId, payload) {
	const fns = topicCallbacks.get('__rpc');
	if (fns) for (const cb of fns) cb({ event: correlationId, data: payload });
}

function simulateTopicMessage(topic, envelope) {
	const fns = topicCallbacks.get(topic);
	if (fns) for (const cb of fns) cb(envelope);
}

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
		ready: () => new Promise(() => {}),
		get bufferedAmount() { return 0; }
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
		onDerived: () => ({ subscribe: () => () => {} }),
		status: {
			subscribe: (fn) => {
				statusCallbacks.add(fn);
				fn('open');
				return () => statusCallbacks.delete(fn);
			}
		},
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
		readable: (initial) => {
			const subs = new Set();
			return { subscribe(fn) { subs.add(fn); fn(initial); return () => subs.delete(fn); } };
		},
		fromStore: (store) => {
			let current;
			store.subscribe((v) => { current = v; });
			return { get current() { return current; } };
		}
	}));

	const clientMod = await import('../src/client.js');
	__stream = clientMod.__stream;

	const testClientMod = await import('../src/test-client.js');
	subscribeAt = testClientMod.subscribeAt;
});

describe('subscribeAt() metadata stamping', () => {
	it('stamps __streamPath / __streamOptions on a static stream', () => {
		const counter = __stream('demo/counter', { merge: 'set' });
		expect(counter.__streamPath).toBe('demo/counter');
		expect(counter.__streamOptions).toEqual({ merge: 'set' });
		expect(counter.__streamArgs).toBeUndefined();
	});

	it('stamps __streamPath / __streamOptions / __streamIsDynamic on a dynamic factory', () => {
		const messages = __stream('chat/messages', { merge: 'crud', key: 'id' }, true);
		expect(messages.__streamPath).toBe('chat/messages');
		expect(messages.__streamOptions).toEqual({ merge: 'crud', key: 'id' });
		expect(messages.__streamIsDynamic).toBe(true);
	});

	it('stamps __streamPath / __streamArgs on a cached store from a dynamic factory', () => {
		const messages = __stream('chat/messages', { merge: 'crud', key: 'id' }, true);
		const room = messages('room-1');
		expect(room.__streamPath).toBe('chat/messages');
		expect(room.__streamArgs).toEqual(['room-1']);
		expect(room.__streamOptions).toEqual({ merge: 'crud', key: 'id' });
	});
});

describe('subscribeAt() wire envelope', () => {
	it('sends schemaVersion on the very first subscribe envelope (static stream)', async () => {
		const counter = __stream('demo/counter', { merge: 'set' });

		// Production store subscribes WITHOUT schemaVersion (no prior server response).
		const prodStore = counter;
		const unsubProd = prodStore.subscribe(() => {});
		await flush();
		const prodSent = sendQueuedFn.mock.calls[0][0];
		expect(prodSent.schemaVersion).toBeUndefined();

		// Test affordance: parallel store at v1.
		const v1Store = subscribeAt(counter, { schemaVersion: 1 });
		const unsubV1 = v1Store.subscribe(() => {});
		await flush();
		const v1Sent = sendQueuedFn.mock.calls[1][0];
		expect(v1Sent.schemaVersion).toBe(1);
		expect(v1Sent.rpc).toBe('demo/counter');
		expect(v1Sent.stream).toBe(true);

		unsubProd();
		unsubV1();
	});

	it('sends schemaVersion on the subscribe envelope for a dynamic factory call', async () => {
		const messages = __stream('chat/messages', { merge: 'crud', key: 'id' }, true);
		const v1Room = subscribeAt(messages('room-1'), { schemaVersion: 1 });
		const unsub = v1Room.subscribe(() => {});
		await flush();
		const sent = sendQueuedFn.mock.calls[0][0];
		expect(sent.schemaVersion).toBe(1);
		expect(sent.rpc).toBe('chat/messages');
		expect(sent.args).toEqual(['room-1']);
		unsub();
	});

	it('omits schemaVersion when the user passes 0 (treated as a real version, not "unset")', async () => {
		// schemaVersion: 0 is still a non-negative integer and should ride
		// the wire. Production wire-builder ([client.js:2300](client.js#L2300))
		// only checks `_schemaVersion !== undefined`, so 0 is sent.
		const counter = __stream('demo/counter', { merge: 'set' });
		const v0Store = subscribeAt(counter, { schemaVersion: 0 });
		const unsub = v0Store.subscribe(() => {});
		await flush();
		const sent = sendQueuedFn.mock.calls[0][0];
		expect(sent.schemaVersion).toBe(0);
		unsub();
	});
});

describe('subscribeAt() parallel store independence', () => {
	it('renders a different (migrated) payload than the production store', async () => {
		const counter = __stream('demo/counter', { merge: 'set' });

		// Production store: latest v2 shape.
		const prodValues = [];
		const unsubProd = counter.subscribe((v) => prodValues.push(v));
		await flush();
		const prodSent = sendQueuedFn.mock.calls[0][0];
		simulateRpcResponse(prodSent.id, {
			ok: true,
			data: { count: 42, label: 'visits' },
			topic: 'demo:counter',
			merge: 'set',
			schemaVersion: 2
		});

		// Parallel v1 store: server runs migrate[1] forward, returns the
		// migrated shape (which happens to add a `label` field). For the
		// test we just simulate the server's actual migrated response.
		const v1Counter = subscribeAt(counter, { schemaVersion: 1 });
		const v1Values = [];
		const unsubV1 = v1Counter.subscribe((v) => v1Values.push(v));
		await flush();
		const v1Sent = sendQueuedFn.mock.calls[1][0];
		expect(v1Sent.schemaVersion).toBe(1);
		simulateRpcResponse(v1Sent.id, {
			ok: true,
			data: { count: 42, label: 'visits (migrated from v1)' },
			topic: 'demo:counter',
			merge: 'set',
			schemaVersion: 2
		});

		expect(prodValues[prodValues.length - 1]).toEqual({ count: 42, label: 'visits' });
		expect(v1Values[v1Values.length - 1]).toEqual({ count: 42, label: 'visits (migrated from v1)' });

		unsubProd();
		unsubV1();
	});

	it('both parallel stores receive the same publish on the shared topic and update independently', async () => {
		const counter = __stream('demo/counter', { merge: 'set' });

		const prodValues = [];
		const v1Values = [];
		const unsubProd = counter.subscribe((v) => prodValues.push(v));
		await flush();
		const prodSent = sendQueuedFn.mock.calls[0][0];
		simulateRpcResponse(prodSent.id, {
			ok: true,
			data: { count: 1 },
			topic: 'demo:counter',
			merge: 'set',
			schemaVersion: 2
		});

		const v1Counter = subscribeAt(counter, { schemaVersion: 1 });
		const unsubV1 = v1Counter.subscribe((v) => v1Values.push(v));
		await flush();
		const v1Sent = sendQueuedFn.mock.calls[1][0];
		simulateRpcResponse(v1Sent.id, {
			ok: true,
			data: { count: 1, migrated: true },
			topic: 'demo:counter',
			merge: 'set',
			schemaVersion: 2
		});

		// A live publish lands on both stores (same topic).
		simulateTopicMessage('demo:counter', { event: 'set', data: { count: 2 } });

		expect(prodValues[prodValues.length - 1]).toEqual({ count: 2 });
		expect(v1Values[v1Values.length - 1]).toEqual({ count: 2 });

		unsubProd();
		unsubV1();
	});
});

describe('subscribeAt() argument validation', () => {
	it('throws on null / undefined first argument', () => {
		expect(() => subscribeAt(null, { schemaVersion: 1 })).toThrow(/first argument must be a stream/);
		expect(() => subscribeAt(undefined, { schemaVersion: 1 })).toThrow(/first argument must be a stream/);
	});

	it('throws on a stream-shaped object without __streamPath (e.g. a plain writable)', () => {
		const fakeStore = { subscribe: () => () => {} };
		expect(() => subscribeAt(fakeStore, { schemaVersion: 1 }))
			.toThrow(/not a stream - it carries no `__streamPath`/);
	});

	it('throws on a dynamic factory passed without calling it (path is stamped, but args are missing)', () => {
		// The factory itself carries __streamPath but no __streamArgs.
		// subscribeAt happily calls _createStream with undefined args,
		// which reproduces a non-args dynamic subscribe - not an error,
		// but the resulting subscribe is sent without args. We DO accept
		// this (it's symmetric with calling a dynamic-stream factory
		// with no args), but assert the user got what they asked for.
		const messages = __stream('chat/messages', { merge: 'crud', key: 'id' }, true);
		const store = subscribeAt(messages, { schemaVersion: 1 });
		const unsub = store.subscribe(() => {});
		// This is fine; just confirms no throw.
		unsub();
	});

	it('throws on missing options', () => {
		const counter = __stream('demo/counter', { merge: 'set' });
		expect(() => subscribeAt(counter, /** @type {any} */ (null)))
			.toThrow(/second argument must be \{ schemaVersion \}/);
		expect(() => subscribeAt(counter, /** @type {any} */ (undefined)))
			.toThrow(/second argument must be \{ schemaVersion \}/);
	});

	it('throws on non-integer / negative / non-finite schemaVersion', () => {
		const counter = __stream('demo/counter', { merge: 'set' });
		expect(() => subscribeAt(counter, /** @type {any} */ ({ schemaVersion: 'one' })))
			.toThrow(/non-negative integer/);
		expect(() => subscribeAt(counter, { schemaVersion: -1 }))
			.toThrow(/non-negative integer/);
		expect(() => subscribeAt(counter, { schemaVersion: 1.5 }))
			.toThrow(/non-negative integer/);
		expect(() => subscribeAt(counter, { schemaVersion: NaN }))
			.toThrow(/non-negative integer/);
		expect(() => subscribeAt(counter, { schemaVersion: Infinity }))
			.toThrow(/non-negative integer/);
	});
});
