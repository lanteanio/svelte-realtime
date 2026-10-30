// A stream that resumes from its cursor gets a replay only when the buffer
// still holds every frame after that cursor. A buffer trimmed past it, or one
// that lost its history, answers from `delta.fromSeq` or the loader, and the
// view is replaced rather than built on the rows the client held. Live frames
// of a stream published through the buffer carry its sequence: one overtaken
// by a newer frame for the same row or value is not applied, and a sequence
// seen again (a repeat, or a counter the buffer restarted while the socket
// stayed up) makes the stream re-snapshot. Runs the real client, the
// installed adapter client and the adapter's test server with the adapter's
// in-memory replay buffer, behind a socket that can repeat and hold frames.

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { get } from 'svelte/store';
import { installLossyWebSocket, frameTopic } from './helpers/lossy-websocket.js';

const lossy = installLossyWebSocket();
const { createTestServer } = await import('svelte-adapter-uws/testing');
const { connect } = await import('svelte-adapter-uws/client');
const { createReplay } = await import('svelte-adapter-uws/plugins/replay');
const { live, realtime, __register, _prepareHmr, _resetLifecycle } = await import('../src/server.js');
const { __stream, simulateOffline, resumeOnline } = await import('../src/client.js');
const { setRuntimeEnv, resetRuntimeEnv } = await import('../src/client-runtime.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(check, what) {
	const end = Date.now() + 3000;
	while (!check()) {
		if (Date.now() >= end) throw new Error('Timed out waiting for ' + what);
		await sleep(5);
	}
}

let server, conn;
let n = 0;

beforeAll(async () => {
	_resetLifecycle();
	server = await createTestServer({ handler: realtime() });
	conn = connect({ url: server.wsUrl, reconnectInterval: 20, maxReconnectInterval: 50 });
});

afterEach(() => {
	resetRuntimeEnv();
	lossy.link.inbound = null;
	resumeOnline();
});

afterAll(async () => {
	conn?.close();
	await server?.close();
	_prepareHmr();
	lossy.restore();
});

/**
 * A crud stream over `rows`, published through a replay buffer of `size`.
 * `write` changes the rows and publishes the change the way the app would.
 */
function declare(size) {
	const topic = 'resume-items-' + ++n;
	const path = 'resume' + n + '/items';
	const rows = new Map();
	__register(path, live.public(live.stream(topic, async () => [...rows.values()], { merge: 'crud', key: 'id', replay: true })));
	server.platform.replay = createReplay({ size });
	const write = (event, row) => {
		if (event === 'deleted') rows.delete(row.id);
		else rows.set(row.id, row);
		server.platform.replay.publish(server.platform, topic, event, row);
	};
	return { topic, path, rows, write };
}

/** Mount the stream, publish `frames` changes to row 1 live, and take the client offline. */
async function loadedThenOffline(d, frames = 1) {
	const store = __stream(d.path, { merge: 'crud', key: 'id' });
	const off = store.subscribe(() => {});
	await until(() => Array.isArray(get(store)), 'the snapshot');
	d.write('created', { id: 1 });
	for (let v = 1; v < frames; v++) d.write('updated', { id: 1, v });
	await until(() => get(store).length === 1 && (get(store)[0].v || 0) === frames - 1, 'the live frames');
	simulateOffline();
	await sleep(20);
	return { store, off };
}

const ids = (rows) => rows.map((r) => r.id + (r.v ? ':' + r.v : '')).sort();

describe('stream resume against a replay buffer that cannot fill the gap', () => {
	it('a buffer trimmed past the cursor answers from the loader and the view is replaced', async () => {
		const d = declare(3);
		const { store, off } = await loadedThenOffline(d);
		// Five frames while offline; the buffer keeps the last three, so the
		// creation of row 2 is gone from it.
		d.write('created', { id: 2 });
		d.write('deleted', { id: 1 });
		d.write('created', { id: 3 });
		d.write('updated', { id: 3, v: 1 });
		d.write('created', { id: 4 });
		resumeOnline();
		await until(() => !get(store).some((r) => r.id === 1), 'the resume');
		await sleep(30);
		expect(ids(get(store))).toEqual(['2', '3:1', '4']);
		// Live frames apply on the new base.
		d.write('updated', { id: 2, v: 1 });
		await until(() => get(store).some((r) => r.v === 1 && r.id === 2), 'the next live frame');
		expect(ids(get(store))).toEqual(['2:1', '3:1', '4']);
		off();
	});

	it('a buffer that lost its history answers from the loader and the cursor follows the new buffer', async () => {
		const d = declare(10);
		const { store, off } = await loadedThenOffline(d, 3);
		d.write('created', { id: 2 });
		d.write('created', { id: 3 });
		// The buffer restarts: its sequence is behind the client's cursor at 3.
		server.platform.replay = createReplay({ size: 10 });
		d.write('deleted', { id: 1 });
		resumeOnline();
		await until(() => !get(store).some((r) => r.id === 1), 'the resume');
		await sleep(30);
		expect(ids(get(store))).toEqual(['2', '3']);
		d.write('created', { id: 5 });
		await until(() => get(store).some((r) => r.id === 5), 'the next live frame');
		expect(ids(get(store))).toEqual(['2', '3', '5']);
		off();
	});

	it('a buffer that holds every frame after the cursor replays them', async () => {
		const d = declare(10);
		const { store, off } = await loadedThenOffline(d);
		let loads = 0;
		__register(d.path, live.public(live.stream(d.topic, async () => { loads++; return [...d.rows.values()]; }, { merge: 'crud', key: 'id', replay: true })));
		d.write('created', { id: 2 });
		d.write('deleted', { id: 1 });
		resumeOnline();
		await until(() => !get(store).some((r) => r.id === 1), 'the resume');
		expect(ids(get(store))).toEqual(['2']);
		expect(loads).toBe(0);
		off();
	});
});

/**
 * A stream of `merge` over `initial`, published through a replay buffer.
 * `publish` changes what the loader reads and publishes the change.
 */
async function mounted(merge, initial, replayOptions = { size: 50 }) {
	const topic = 'ordered-' + ++n;
	const path = 'ordered' + n + '/feed';
	let state = initial;
	const read = () => (Array.isArray(state) ? state.slice() : state);
	let loads = 0;
	__register(path, live.public(live.stream(topic, async () => { loads++; return read(); }, merge === 'crud' ? { merge, key: 'id', replay: true } : { merge, replay: true })));
	server.platform.replay = createReplay(replayOptions);
	const store = __stream(path, merge === 'crud' ? { merge, key: 'id' } : { merge });
	const off = store.subscribe(() => {});
	await until(() => get(store) !== undefined, 'the snapshot');
	const publish = (event, data) => {
		if (merge === 'set') state = data;
		else if (merge === 'latest') state = [...state, data];
		else if (event === 'deleted') state = state.filter((r) => r.id !== data.id);
		else state = [...state.filter((r) => r.id !== data.id), data];
		server.platform.replay.publish(server.platform, topic, event, data);
	};
	return { topic, store, off, publish, loads: () => loads };
}

/** Repeat every frame on `topic`. */
const repeatFrames = (topic) => {
	lossy.link.inbound = (event, deliver) => {
		deliver();
		if (frameTopic(event) === topic) deliver();
	};
};

/** Deliver the first frame on `topic` again after the second one. */
const repeatFirstAfterSecond = (topic) => {
	let first = null;
	let done = false;
	lossy.link.inbound = (event, deliver) => {
		deliver();
		if (done || frameTopic(event) !== topic) return;
		if (first === null) { first = event; return; }
		done = true;
		deliver(first);
	};
	return () => done;
};

/** Hold the first frame on `topic` until the next one has been delivered. */
const swapFirstTwo = (topic) => {
	let held = null;
	let done = false;
	lossy.link.inbound = (event, deliver) => {
		if (done || frameTopic(event) !== topic) return deliver();
		if (held === null) { held = deliver; return; }
		done = true;
		deliver();
		held();
	};
	return () => done;
};

describe('live frames repeated or overtaken on the way to a sequenced stream', () => {
	it('a crud row ends on its newest change and a repeated create does not bring a deleted row back', async () => {
		const { topic, store, off, publish } = await mounted('crud', [{ id: 1, v: 0 }]);
		const swapped = swapFirstTwo(topic);
		publish('updated', { id: 1, v: 1 });
		publish('updated', { id: 1, v: 2 });
		await until(swapped, 'the swapped pair');
		await until(() => get(store)[0].v === 2, 'the newer change');
		await sleep(20);
		expect(get(store)).toEqual([{ id: 1, v: 2 }]);

		const repeated = repeatFirstAfterSecond(topic);
		publish('created', { id: 2 });
		publish('deleted', { id: 2 });
		await until(repeated, 'the repeated create');
		publish('created', { id: 3 });
		await until(() => get(store).some((r) => r.id === 3), 'the last frame');
		await sleep(20);
		expect(get(store)).toEqual([{ id: 1, v: 2 }, { id: 3 }]);
		off();
	});

	it('a set stream keeps the newer value when the older one arrives after it', async () => {
		const { topic, store, off, publish } = await mounted('set', { owner: 'ann' });
		const swapped = swapFirstTwo(topic);
		publish('set', { owner: 'bob' });
		publish('set', { owner: 'cat' });
		await until(swapped, 'the swapped pair');
		await sleep(20);
		expect(get(store)).toEqual({ owner: 'cat' });
		off();
	});

	it('a latest stream does not list a repeated frame twice', async () => {
		setRuntimeEnv({ rng: { float: () => 0 } });
		const { topic, store, off, publish, loads } = await mounted('latest', []);
		repeatFrames(topic);
		publish('push', { id: 1 });
		publish('push', { id: 2 });
		await until(() => loads() > 1 && get(store).length === 2, 'the re-snapshot');
		await sleep(20);
		expect(get(store)).toEqual([{ id: 1 }, { id: 2 }]);
		off();
	});
});

describe('a sequence the buffer restarts while the client stays connected', () => {
	/** Evict the stream's topic from a one-topic buffer, which restarts its counter. */
	const evict = () => server.platform.replay.publish(server.platform, 'evictor-' + n, 'noop', null);

	it.each([
		['set', { owner: 'ann' }, [['set', { owner: 'bob' }], ['set', { owner: 'cat' }]], ['set', { owner: 'dan' }], ['set', { owner: 'eve' }], { owner: 'eve' }],
		['crud', [], [['created', { id: 1 }], ['created', { id: 2 }]], ['deleted', { id: 1 }], ['created', { id: 3 }], [{ id: 2 }, { id: 3 }]],
		['latest', [], [['push', { id: 1 }], ['push', { id: 2 }]], ['push', { id: 3 }], ['push', { id: 4 }], [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }]]
	])('a %s stream re-snapshots on the restarted sequence and applies the frames after it', async (merge, initial, before, first, next, expected) => {
		setRuntimeEnv({ rng: { float: () => 0 } });
		const { store, off, publish, loads } = await mounted(merge, initial, { size: 50, maxTopics: 1 });
		for (const [event, data] of before) publish(event, data);
		await sleep(30);
		expect(loads()).toBe(1);
		evict();
		publish(...first);
		await until(() => loads() === 2, 'the re-snapshot');
		await sleep(30);
		publish(...next);
		await sleep(30);
		const value = get(store);
		expect(merge === 'crud' ? [...value].sort((a, b) => a.id - b.id) : value).toEqual(expected);
		expect(loads()).toBe(2);
		off();
	});
});

describe('a resume answered by delta.fromSeq', () => {
	it('applies the application events without the buffer continuity check', async () => {
		const topic = 'bridged-' + ++n;
		const path = 'bridged' + n + '/feed';
		let rows = [{ id: 1 }];
		let loads = 0;
		__register(path, live.public(live.stream(topic, async () => { loads++; return rows.slice(); }, {
			merge: 'crud', key: 'id', replay: true,
			// Sequences from a table shared by many topics: not the buffer's
			// numbering, and with gaps.
			delta: { fromSeq: async () => [
				{ seq: 120, event: 'created', data: { id: 2 } },
				{ seq: 245, event: 'deleted', data: { id: 1 } }
			] }
		})));
		server.platform.replay = createReplay({ size: 2 });
		const store = __stream(path, { merge: 'crud', key: 'id' });
		const off = store.subscribe(() => {});
		await until(() => Array.isArray(get(store)), 'the snapshot');
		const publish = (event, data) => server.platform.replay.publish(server.platform, topic, event, data);
		publish('updated', { id: 1, v: 1 });
		await until(() => get(store)[0]?.v === 1, 'the live frame');
		simulateOffline();
		await sleep(20);
		rows = [{ id: 2 }];
		publish('created', { id: 2 });
		publish('deleted', { id: 1 });
		publish('updated', { id: 2 });
		resumeOnline();
		await until(() => !get(store).some((r) => r.id === 1), 'the resume');
		await sleep(30);
		expect(get(store)).toEqual([{ id: 2 }]);
		expect(loads).toBe(1);
		// Live frames after it still apply.
		publish('created', { id: 3 });
		await until(() => get(store).some((r) => r.id === 3), 'the next live frame');
		off();
	});
});
