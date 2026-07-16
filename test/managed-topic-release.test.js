// Regression for the client-side explicit wire-release of server-managed topics
// (stream.js `_sendManagedRelease`). The adapter client suppresses the
// unsubscribe frame for a managed topic, so the realtime client sends its own
// on the LAST local ref release - that frame is what runs the server's
// unsubscribe hook chain (room enumeration release, presence leave, owner
// succession) instead of leaking the subscription until socket close.
//
// Two defects fixed here, both from the old `_socketIsOpen()` status probe:
//   1. it returned false for the adapter's 'suspended' state (a backgrounded
//      tab whose socket is STILL open and still carries frames), so the release
//      was dropped on a live wire - re-leaking the very subscription it exists
//      to free, on the common "unmount live views when the tab hides" pattern;
//   2. reading the adapter `status` store routes through ensureConnection, which
//      re-creates (and reconnects) a connection the app had explicitly close()d.
//
// The fix drops the probe: the frame is handed to the adapter's send() (which
// gates on readyState === OPEN, so it delivers on an open OR 'suspended' socket
// and no-ops otherwise), and is skipped only when the realtime client is
// `terminated` - an explicit close, where there is no server subscription to
// release and resurrecting the socket would be wrong. These tests drive a REAL
// stream through subscribe -> topic-resolve -> teardown and assert the exact
// wire frame the mock connection received.

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
		ready: () => new Promise(() => {}),
		get bufferedAmount() { return 0; }
	};

	vi.doMock('svelte-adapter-uws/client', () => ({
		connect: () => conn,
		// Presence of this export flips `_hasManagedMarking` true, so the stream
		// takes a managed ref at topic resolution (the code path under test).
		setTopicManaged: () => {},
		on: (topic) => ({
			subscribe: (fn) => {
				let fns = topicCallbacks.get(topic);
				if (!fns) { fns = new Set(); topicCallbacks.set(topic, fns); }
				fns.add(fn);
				return () => { fns.delete(fn); if (fns.size === 0) topicCallbacks.delete(topic); };
			}
		}),
		onDerived: () => ({ subscribe: () => () => {} }),
		status: { subscribe: (fn) => { fn(statusValue); return () => {}; } },
		failure: { subscribe: (fn) => { fn(null); return () => {}; } },
		denials: { subscribe: (fn) => { fn(null); return () => {}; } },
		onRequest: () => () => {}
	}));

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
	it('sends an explicit unsubscribe frame when the last local ref is dropped on an open socket', async () => {
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
