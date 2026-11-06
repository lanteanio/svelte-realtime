// A stream that resumes through `delta.fromSeq` numbers its events itself and
// publishes each one with that number. Runs the real client, the installed
// adapter client and the adapter's test server with a replay buffer installed
// on the platform, which these streams do not declare: the cursor stays in the
// application's numbering across consecutive resumes, and a stream with a
// topic factory answers each subscriber from its own topic.

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { get } from 'svelte/store';
import { createTestServer } from 'svelte-adapter-uws/testing';
import { connect } from 'svelte-adapter-uws/client';
import { createReplay } from 'svelte-adapter-uws/plugins/replay';
import { live, realtime, publish, __register, _prepareHmr, _resetLifecycle } from '../src/server.js';
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
 * An audit log per organization in an application store that numbers each
 * organization's rows from 1, and a stream with a topic factory over it whose
 * `delta.fromSeq` reads the organization it is given. `write` stores a row and
 * publishes it with its stored number; `bridged` records every bridge call.
 */
function declare() {
	const id = ++n;
	const path = 'fromseq' + id + '/audit';
	const logs = new Map();
	const topicOf = (orgId) => 'fromseq-audit-' + id + ':' + orgId;
	const d = { path, topicOf, bridged: [], write: null, open: null };
	__register(path, live.public(live.stream(
		(ctx, orgId) => topicOf(orgId),
		async (ctx, orgId) => [...(logs.get(orgId) || [])],
		{
			merge: 'crud', key: 'id',
			delta: {
				fromSeq: async (sinceSeq, ctx, orgId) => {
					d.bridged.push({ sinceSeq, orgId, hasCtx: !!(ctx && ctx.platform) });
					return (logs.get(orgId) || []).filter((row) => row.seq > sinceSeq).map((row) => ({ event: 'created', data: row, seq: row.seq }));
				}
			}
		}
	)));
	d.write = (orgId, text) => {
		if (!logs.has(orgId)) logs.set(orgId, []);
		const rows = logs.get(orgId);
		const seq = rows.length + 1;
		const row = { id: orgId + '-' + seq, orgId, text, seq };
		rows.push(row);
		// The documented path: publish through realtime with the stored number.
		publish(topicOf(orgId), 'created', row, { seq });
	};
	d.open = async (orgId) => {
		const store = /** @type {any} */ (__stream(path, { merge: 'crud', key: 'id' }, true))(orgId);
		const off = store.subscribe(() => {});
		await until(() => Array.isArray(get(store)), 'the snapshot of ' + orgId);
		return { store, off };
	};
	return d;
}

const texts = (rows) => rows.map((r) => r.text).sort();

async function offlineThenResume(d, calls) {
	simulateOffline();
	await sleep(20);
	return () => {
		resumeOnline();
		return until(() => d.bridged.length >= calls, 'resume ' + calls);
	};
}

describe('delta.fromSeq resume on a platform with a replay buffer', () => {
	it.each([
		['an empty buffer counter', 0],
		['a buffer counter ahead of the application', 5]
	])('two resumes in a row keep the cursor in the application numbering (%s)', async (_label, bufferFrames) => {
		server.platform.replay = createReplay({ size: 10 });
		const d = declare();
		const { store, off } = await d.open('org-a');
		d.write('org-a', 'one');
		await until(() => get(store).length === 1, 'the live row');
		// Frames that reach the buffer under this topic but not this client move
		// the buffer's counter past the application's numbering.
		const elsewhere = { publish() { return true; } };
		for (let i = 0; i < bufferFrames; i++) server.platform.replay.publish(elsewhere, d.topicOf('org-a'), 'created', { id: 'buffer-' + i });

		// First resume: nothing was missed, the bridge answers empty.
		let resume = await offlineThenResume(d, 1);
		await resume();
		await sleep(30);
		expect(d.bridged[0]).toMatchObject({ sinceSeq: 1, orgId: 'org-a', hasCtx: true });

		// Second resume: one row was missed. The bridge is asked from the same
		// cursor, so the row arrives.
		resume = await offlineThenResume(d, 2);
		d.write('org-a', 'two');
		await resume();
		await until(() => get(store).length === 2, 'the missed row');
		expect(d.bridged[1]).toMatchObject({ sinceSeq: 1, orgId: 'org-a' });
		expect(texts(get(store))).toEqual(['one', 'two']);

		// A third resume after a live row continues from that row's number.
		d.write('org-a', 'three');
		await until(() => get(store).length === 3, 'the next live row');
		resume = await offlineThenResume(d, 3);
		await resume();
		await sleep(30);
		expect(d.bridged[2]).toMatchObject({ sinceSeq: 3, orgId: 'org-a' });
		expect(texts(get(store))).toEqual(['one', 'three', 'two']);
		off();
	});

	it('a stream with a topic factory answers each subscriber from its own topic', async () => {
		server.platform.replay = createReplay({ size: 10 });
		const d = declare();
		const a = await d.open('org-a');
		const b = await d.open('org-b');
		d.write('org-a', 'a1');
		d.write('org-b', 'b1');
		await until(() => get(a.store).length === 1 && get(b.store).length === 1, 'the live rows');
		const resume = await offlineThenResume(d, 2);
		d.write('org-a', 'a2');
		d.write('org-b', 'b2');
		d.write('org-b', 'b3');
		await resume();
		await until(() => get(a.store).length === 2 && get(b.store).length === 3, 'the missed rows');
		await sleep(30);
		expect(texts(get(a.store))).toEqual(['a1', 'a2']);
		expect(texts(get(b.store))).toEqual(['b1', 'b2', 'b3']);
		expect(d.bridged.map((c) => c.orgId).sort()).toEqual(['org-a', 'org-b']);
		expect(d.bridged.every((c) => c.sinceSeq === 1 && c.hasCtx)).toBe(true);
		a.off();
		b.off();
	});
});
