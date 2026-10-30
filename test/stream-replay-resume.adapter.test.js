// A stream that resumes from its cursor gets a replay only when the buffer
// still holds every frame after that cursor. A buffer trimmed past it, or one
// whose sequence restarted behind it, answers from `delta.fromSeq` or the
// loader, and the view is replaced rather than built on the rows the client
// held. A `delta.fromSeq` answer is applied as given, and the client's cursor
// stays in the buffer's numbering. Runs the real client, the installed
// adapter client and the adapter's test server with the adapter's in-memory
// replay buffer.

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { get } from 'svelte/store';
import { createTestServer } from 'svelte-adapter-uws/testing';
import { connect } from 'svelte-adapter-uws/client';
import { createReplay } from 'svelte-adapter-uws/plugins/replay';
import { live, realtime, __register, _prepareHmr, _resetLifecycle } from '../src/server.js';
import { __stream, simulateOffline, resumeOnline } from '../src/client.js';

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
	resumeOnline();
});

afterAll(async () => {
	conn?.close();
	await server?.close();
	_prepareHmr();
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

describe('a resume answered by delta.fromSeq', () => {
	it('keeps the cursor in the buffer numbering, so the next resume replays what came after', async () => {
		const topic = 'bridged-' + ++n;
		const path = 'bridged' + n + '/feed';
		const rows = new Map([[1, { id: 1 }]]);
		// The application's log: each event with the buffer sequence it was
		// published under, and the application's own id for it in `seq`,
		// numbered from a table shared by many topics.
		const log = [];
		let loads = 0;
		const sinceCalls = [];
		__register(path, live.public(live.stream(topic, async () => { loads++; return [...rows.values()]; }, {
			merge: 'crud', key: 'id', replay: true,
			delta: { fromSeq: async (since) => {
				sinceCalls.push(since);
				return log.filter((e) => e.bufferSeq > since).map((e) => ({ seq: 1000 + e.bufferSeq * 7, event: e.event, data: e.data }));
			} }
		})));
		server.platform.replay = createReplay({ size: 2 });
		const publish = (event, data) => {
			if (event === 'deleted') rows.delete(data.id);
			else rows.set(data.id, data);
			server.platform.replay.publish(server.platform, topic, event, data);
			log.push({ bufferSeq: server.platform.replay.seq(topic), event, data });
		};
		const store = __stream(path, { merge: 'crud', key: 'id' });
		const off = store.subscribe(() => {});
		await until(() => Array.isArray(get(store)), 'the snapshot');
		publish('updated', { id: 1, v: 1 });
		await until(() => get(store)[0]?.v === 1, 'the live frame');

		// Offline past the buffer: seq 2..4 published, the buffer keeps 3..4.
		simulateOffline();
		await sleep(20);
		publish('created', { id: 2 });
		publish('deleted', { id: 1 });
		publish('created', { id: 3 });
		resumeOnline();
		await until(() => get(store).some((r) => r.id === 3), 'the bridged resume');
		await sleep(30);
		expect(sinceCalls).toEqual([1]);
		expect(ids(get(store))).toEqual(['2', '3']);

		// A live frame, then offline again within the buffer: the cursor is the
		// buffer's 5, so the buffer replays 6..7 and the bridge is not asked.
		publish('created', { id: 4 });
		await until(() => get(store).some((r) => r.id === 4), 'the next live frame');
		simulateOffline();
		await sleep(20);
		publish('created', { id: 5 });
		publish('updated', { id: 2, v: 1 });
		resumeOnline();
		await until(() => get(store).some((r) => r.id === 5), 'the replayed resume');
		await sleep(30);
		expect(ids(get(store))).toEqual(['2:1', '3', '4', '5']);
		expect(sinceCalls).toEqual([1]);
		expect(loads).toBe(1);
		off();
	});
});
