// A stream that resumes from its cursor gets a replay only when the buffer
// still holds every frame after that cursor. A buffer trimmed past it, or one
// that lost its history, answers from the loader, and the view is replaced
// rather than built on the rows the client held. Live frames of a stream
// published through the buffer carry its sequence, so a repeated frame, or
// one overtaken by a newer frame for the same row or value, is not applied.
// Runs the real client, the installed adapter client and the adapter's test
// server with the adapter's in-memory replay buffer, behind a socket that can
// repeat and hold frames.

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { get } from 'svelte/store';
import { installLossyWebSocket, frameTopic } from './helpers/lossy-websocket.js';

const lossy = installLossyWebSocket();
const { createTestServer } = await import('svelte-adapter-uws/testing');
const { connect } = await import('svelte-adapter-uws/client');
const { createReplay } = await import('svelte-adapter-uws/plugins/replay');
const { live, realtime, __register, _prepareHmr, _resetLifecycle } = await import('../src/server.js');
const { __stream, simulateOffline, resumeOnline } = await import('../src/client.js');

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

/** A stream of `merge` over `initial`, published through a replay buffer. */
async function mounted(merge, initial) {
	const topic = 'ordered-' + ++n;
	const path = 'ordered' + n + '/feed';
	__register(path, live.public(live.stream(topic, async () => initial, merge === 'crud' ? { merge, key: 'id', replay: true } : { merge, replay: true })));
	server.platform.replay = createReplay({ size: 50 });
	const store = __stream(path, merge === 'crud' ? { merge, key: 'id' } : { merge });
	const off = store.subscribe(() => {});
	await until(() => get(store) !== undefined, 'the snapshot');
	const publish = (event, data) => server.platform.replay.publish(server.platform, topic, event, data);
	return { topic, store, off, publish };
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

	it('a latest stream appends a repeated frame once', async () => {
		const { topic, store, off, publish } = await mounted('latest', []);
		repeatFrames(topic);
		publish('push', { id: 1 });
		publish('push', { id: 2 });
		await until(() => get(store).some((r) => r.id === 2), 'both frames');
		await sleep(20);
		expect(get(store)).toEqual([{ id: 1 }, { id: 2 }]);
		off();
	});
});
