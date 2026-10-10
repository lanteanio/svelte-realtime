// Managed stream ownership uses adapter subscriptions, including while a
// subscribe is still waiting for its answer. The adapter sends the wire
// unsubscribe on its final ref; realtime does not send a second frame.

import { describe, it, expect, vi, beforeEach } from 'vitest';

let __stream, clientState;
let topicCallbacks;
let sentFrames;    // conn.send(...)       - immediate; the managed release rides this
let queuedFrames;  // conn.sendQueued(...) - the subscribe RPC frame
let statusValue;

function simulateRpcResponse(correlationId, payload) {
	const fns = topicCallbacks.get('__rpc');
	if (fns) for (const cb of [...fns]) cb({ event: correlationId, data: payload });
}

const flush = () => new Promise((r) => queueMicrotask(r));

beforeEach(async () => {
	vi.resetModules();
	topicCallbacks = new Map();
	sentFrames = [];
	queuedFrames = [];
	statusValue = 'open';

	// One shared connection object (the adapter's connect() is a singleton), so
	// frames from both send() and sendQueued() accumulate on it.
	const conn = {
		send: (f) => { sentFrames.push(f); },
		sendQueued: (f) => { queuedFrames.push(f); },
		get bufferedAmount() { return 0; }
	};

	const adapterMock = {
		connect: () => conn,
		// Presence of this export flips `_hasManagedMarking` true, so the stream
		// takes a managed ref at topic resolution (the code path under test).
		setTopicManaged: () => {},
		on: (topic) => ({
			subscribe: (fn) => {
				let fns = topicCallbacks.get(topic);
				if (!fns) { fns = new Set(); topicCallbacks.set(topic, fns); }
				fns.add(fn);
				return () => { fns.delete(fn); if (fns.size === 0) { topicCallbacks.delete(topic); if (!topic.startsWith('__') && !clientState?.terminated) sentFrames.push({ type: 'unsubscribe', topic }); } };
			}
		}),
		onDerived: () => ({ subscribe: () => () => {} }),
		status: { subscribe: (fn) => { fn(statusValue); return () => {}; } },
		failure: { subscribe: (fn) => { fn(null); return () => {}; } },
		denials: { subscribe: (fn) => { fn(null); return () => {}; } },
		onRequest: () => () => {}
	};
	// Like the adapter's, the connection object carries the module's topic
	// factory, stores and request hook.
	Object.assign(conn, {
		on: adapterMock.on,
		status: adapterMock.status,
		failure: adapterMock.failure,
		denials: adapterMock.denials,
		onRequest: adapterMock.onRequest
	});
	vi.doMock('svelte-adapter-uws/client', () => adapterMock);

	const clientMod = await import('../src/client.js');
	__stream = clientMod.__stream;
	// Same module instance stream.js reads (resolved to the same file).
	clientState = (await import('../src/client/internal-state.js')).clientState;
});

// Subscribe a stream and drive its subscribe RPC response so the client resolves
// the wire topic (which marks it managed and takes the managed ref). Returns the
// subscriber's unsubscribe fn.
async function joinResolved(path, wireTopic) {
	const s = __stream(path, { merge: 'set' });
	const off = s.subscribe(() => {});
	await flush();
	const sub = queuedFrames.find((f) => f && f.stream && !f.__consumed);
	sub.__consumed = true;
	simulateRpcResponse(sub.id, { ok: true, data: null, topic: wireTopic, merge: 'set' });
	await flush();
	return off;
}

const releaseFrames = (topic) =>
	sentFrames.filter((f) => f && f.type === 'unsubscribe' && f.topic === topic);

describe('managed-topic wire release', () => {
	it('lets the adapter send one unsubscribe frame when the last local ref is dropped on an open socket', async () => {
		const off = await joinResolved('demo/counter', 'demo:counter');
		expect(releaseFrames('demo:counter')).toHaveLength(0); // nothing yet

		off();
		await flush();
		expect(releaseFrames('demo:counter')).toEqual([{ type: 'unsubscribe', topic: 'demo:counter' }]);
	});

	it('still sends the release on a backgrounded ("suspended") socket - the old status probe dropped it', async () => {
		// The socket is open (frames deliver), the tab is just hidden. The fix must
		// not gate on status === 'open'; the adapter send() decides deliverability.
		statusValue = 'suspended';
		const off = await joinResolved('demo/counter', 'demo:counter');

		off();
		await flush();
		expect(releaseFrames('demo:counter')).toHaveLength(1);
	});

	it('does NOT send (and does not resurrect the socket) when the client is terminated', async () => {
		const off = await joinResolved('demo/counter', 'demo:counter');

		// The app called connect().close(): the realtime client is terminated and
		// there is no live subscription to release.
		clientState.terminated = true;
		off();
		await flush();
		expect(releaseFrames('demo:counter')).toHaveLength(0);
	});

	it('refcounts across stream instances that share one wire topic: only the LAST release sends', async () => {
		// Two distinct stream paths the server resolved onto the SAME wire topic
		// (e.g. under stream-cache overflow). Each holds a ref; releasing one must
		// not kill the other's live subscription.
		const offA = await joinResolved('room/a', 'shared:t');
		const offB = await joinResolved('room/b', 'shared:t');

		offA();
		await flush();
		expect(releaseFrames('shared:t')).toHaveLength(0); // B still holds a ref

		offB();
		await flush();
		expect(releaseFrames('shared:t')).toEqual([{ type: 'unsubscribe', topic: 'shared:t' }]);
	});
});


describe('overlapping subscribes on one managed topic', () => {
	it.each(['unnamed', 'named', 'resolved'])('a refused attach keeps its sibling alive (%s sibling)', async phase => {
		const first = __stream('overlap/first', { merge: 'crud', key: 'id' });
		const second = __stream('overlap/second', { merge: 'crud', key: 'id' });
		const offFirst = first.subscribe(() => {});
		await flush(); const requestA = queuedFrames.at(-1);
		simulateRpcResponse(requestA.id, { attach: true, topic: 'overlap:shared' });
		const values = [], offSecond = second.subscribe(value => values.push(value));
		await flush(); const requestB = queuedFrames.at(-1);
		if (phase !== 'unnamed') simulateRpcResponse(requestB.id, { attach: true, topic: 'overlap:shared' });
		if (phase === 'resolved') simulateRpcResponse(requestB.id, { ok: true, topic: 'overlap:shared', data: [], merge: 'crud', key: 'id' });
		simulateRpcResponse(requestA.id, { ok: false, code: 'FORBIDDEN', error: 'refused' });
		expect(releaseFrames('overlap:shared')).toHaveLength(0);
		if (phase === 'unnamed') simulateRpcResponse(requestB.id, { attach: true, topic: 'overlap:shared' });
		if (phase !== 'resolved') simulateRpcResponse(requestB.id, { ok: true, topic: 'overlap:shared', data: [], merge: 'crud', key: 'id' });
		for (const receive of [...topicCallbacks.get('overlap:shared')]) receive({ event: 'created', data: { id: 1 } });
		expect(values.at(-1)).toEqual([{ id: 1 }]);
		offFirst(); await flush();
		expect(releaseFrames('overlap:shared')).toHaveLength(0);
		offSecond(); await flush();
		expect(releaseFrames('overlap:shared')).toEqual([{ type: 'unsubscribe', topic: 'overlap:shared' }]);
	});
});
