// A stream that resumes from its cursor gets a replay only when the buffer
// still holds every frame after that cursor. A buffer trimmed past it, or one
// whose sequence restarted behind it, answers from the loader - never from
// `delta.fromSeq`, whose events the application numbers - and the view is
// replaced rather than built on the rows the client held. Runs the real
// client, the installed adapter client and the adapter's test server with the
// adapter's in-memory replay buffer.

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
 * Its `delta.fromSeq` would answer with a row that does not exist; `bridged`
 * counts the calls.
 */
function declare(size) {
	const topic = 'resume-items-' + ++n;
	const path = 'resume' + n + '/items';
	const rows = new Map();
	const d = { topic, path, rows, bridged: 0, write: null };
	__register(path, live.public(live.stream(topic, async () => [...rows.values()], {
		merge: 'crud', key: 'id', replay: true,
		delta: { fromSeq: async () => { d.bridged++; return [{ seq: 99, event: 'created', data: { id: 99 } }]; } }
	})));
	server.platform.replay = createReplay({ size });
	d.write = (event, row) => {
		if (event === 'deleted') rows.delete(row.id);
		else rows.set(row.id, row);
		server.platform.replay.publish(server.platform, topic, event, row);
	};
	return d;
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
		expect(d.bridged).toBe(0);
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
		expect(d.bridged).toBe(0);
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

describe('a stream whose events each replace the whole value', () => {
	it('a flag resumes to the latest set the buffer holds when it kept only that one', async () => {
		const topic = 'resume-flag-' + ++n;
		const path = 'resumeflag' + n + '/mode';
		__register(path, live.public(live.flag(topic, 'off')));
		server.platform.replay = createReplay({ size: 1 });
		const store = __stream(path, { merge: 'set' });
		const off = store.subscribe(() => {});
		await until(() => get(store) === 'off', 'the snapshot');
		server.platform.replay.publish(server.platform, topic, 'set', 'a');
		await until(() => get(store) === 'a', 'the live set');
		simulateOffline();
		await sleep(20);
		// Two sets this replica never saw, as on a replica that booted after
		// them: they reach the shared buffer but not its flag value, which is
		// what its loader serves.
		const elsewhere = { publish() { return true; } };
		server.platform.replay.publish(elsewhere, topic, 'set', 'b');
		server.platform.replay.publish(elsewhere, topic, 'set', 'c');
		resumeOnline();
		await until(() => get(store) === 'c', 'the resume').catch(() => {});
		expect(get(store)).toBe('c');
		off();
	});

	it('a set stream resumes from the newest value the buffer holds, whatever came before it', async () => {
		const topic = 'resume-set-' + ++n;
		const path = 'resumeset' + n + '/state';
		let loads = 0;
		__register(path, live.public(live.stream(topic, async () => { loads++; return { v: 'loader' }; }, { merge: 'set', replay: true })));
		server.platform.replay = createReplay({ size: 1 });
		const set = (value) => server.platform.replay.publish(server.platform, topic, 'set', value);
		const store = __stream(path, { merge: 'set' });
		const off = store.subscribe(() => {});
		await until(() => get(store) !== undefined, 'the snapshot');
		set({ v: 1 });
		await until(() => get(store).v === 1, 'the live set');
		simulateOffline();
		await sleep(20);
		set({ v: 2 });
		set({ v: 3 });
		resumeOnline();
		await until(() => get(store).v === 3, 'the resume');
		expect(loads).toBe(1);
		off();
	});
});
