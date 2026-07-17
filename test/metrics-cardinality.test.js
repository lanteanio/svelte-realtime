// Unknown/unregistered RPC paths and arbitrary codes must NOT allocate one
// Prometheus series per distinct value. An unauthenticated
// caller can spray valid-format but unregistered paths; pre-fix each created its
// own `path=<raw>` series, inflating registry memory and scrape/query cost (the
// extensions cap only drops after the first 10,000). Dispatch now folds an
// unregistered path to `__unknown__` and a malformed request to `__invalid__`
// before it emits, and _recordRpcMetrics length-bounds every label as a backstop.
// Driven through the REAL handleRpc dispatch path; asserts the emitted series.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { live } from '../src/server.js';
import { state } from '../src/server/state.js';
import { _recordRpcMetrics } from '../src/server/metrics.js';
import { createTestEnv } from '../src/testing.js';
import { handleRpc } from '../src/server/dispatch.js';

const enc = new TextEncoder();
const settle = (ms = 20) => new Promise((r) => setTimeout(r, ms));

// A minimal metrics registry that records every instrument label set.
function fakeRegistry() {
	const series = new Map();
	const record = (name) => (op) => (labels, value) => {
		let list = series.get(name);
		if (!list) { list = []; series.set(name, list); }
		list.push({ op, labels, value });
	};
	return {
		series,
		counter: ({ name }) => ({ inc: record(name)('inc') }),
		histogram: ({ name }) => ({ observe: record(name)('observe') }),
		gauge: ({ name }) => ({ inc: record(name)('inc'), dec: record(name)('dec'), set: record(name)('set') })
	};
}

function openWs() {
	const topics = new Set();
	return {
		getUserData: () => ({}),
		subscribe: (t) => { topics.add(t); return true; },
		unsubscribe: (t) => { topics.delete(t); return true; },
		isSubscribed: (t) => topics.has(t),
		getTopics: () => [...topics],
		_onSend: () => {}
	};
}

const send = (env, ws, frame) => handleRpc(ws, enc.encode(JSON.stringify(frame)).buffer, env.platform);
const rpcPaths = (reg) => (reg.series.get('svelte_realtime_rpc_total') || []).map((e) => e.labels.path);
const errSeries = (reg) => reg.series.get('svelte_realtime_rpc_errors_total') || [];

// Binary RPC frame: byte[0]=0x00, byte[1-2]=header length (uint16 BE), JSON header.
function binaryFrame(rpc, id = 'x') {
	const hb = enc.encode(JSON.stringify({ rpc, id }));
	const buf = new Uint8Array(3 + hb.length);
	buf[0] = 0x00;
	buf[1] = (hb.length >> 8) & 0xff;
	buf[2] = hb.length & 0xff;
	buf.set(hb, 3);
	return buf.buffer;
}

// Upload chunk-0 frame: byte[0]=0x01, flags=HAS_ARGS, streamId, seq=0, args header.
function uploadChunk0Frame(streamId, rpc) {
	const ab = enc.encode(JSON.stringify({ rpc, args: [] }));
	const buf = new Uint8Array(12 + ab.length);
	const view = new DataView(buf.buffer);
	view.setUint8(0, 0x01);               // _UPLOAD_FRAME_CHUNK
	view.setUint8(1, 0x01);               // flags = HAS_ARGS (required on chunk 0)
	view.setUint32(2, streamId, false);   // streamId (BE)
	view.setUint32(6, 0, false);          // seq = 0
	view.setUint16(10, ab.length, false); // args-header length (BE)
	buf.set(ab, 12);
	return buf.buffer;
}

describe('RPC metric label cardinality', () => {
	let env, reg;

	beforeEach(() => {
		env = createTestEnv();
		reg = fakeRegistry();
		live.metrics(reg); // configure AFTER createTestEnv so it wins the global state
	});

	afterEach(() => {
		state.metricsInstruments = null;
		state.metricsLifeline = undefined;
		env.cleanup();
	});

	it('folds N distinct UNREGISTERED paths into ONE __unknown__ series (not one per path)', async () => {
		const ws = openWs();
		for (let i = 0; i < 20; i++) send(env, ws, { rpc: 'ghost/p' + i, id: 'x', args: [] });
		await settle();
		const paths = rpcPaths(reg);
		expect(paths.length).toBe(20);                              // 20 calls recorded
		expect(new Set(paths)).toEqual(new Set(['__unknown__']));   // but a SINGLE series
		expect(new Set(errSeries(reg).map((e) => e.labels.path))).toEqual(new Set(['__unknown__']));
		expect(new Set(errSeries(reg).map((e) => e.labels.code))).toEqual(new Set(['NOT_FOUND']));
	});

	it('folds a non-array-args request to __invalid__, never the raw client path', async () => {
		const ws = openWs();
		send(env, ws, { rpc: 'ghost/badargs', id: 'x', args: { not: 'an array' } });
		await settle();
		expect(rpcPaths(reg)).toEqual(['__invalid__']);
	});

	it('preserves the real label for a REGISTERED path (the fold is conditional, not blanket)', async () => {
		env.register('demo', { ping: live(async () => 'pong') });
		const ws = openWs();
		send(env, ws, { rpc: 'demo/ping', id: 'x', args: [] });
		await settle();
		expect(rpcPaths(reg)).toEqual(['demo/ping']);
	});

	it('folds N distinct UNREGISTERED BINARY-RPC paths into one __unknown__ series', async () => {
		const ws = openWs();
		for (let i = 0; i < 15; i++) handleRpc(ws, binaryFrame('ghostbin/p' + i), env.platform);
		await settle();
		expect(new Set(rpcPaths(reg))).toEqual(new Set(['__unknown__']));
		expect(rpcPaths(reg).length).toBeGreaterThanOrEqual(15);
		expect(new Set(errSeries(reg).map((e) => e.labels.code))).toEqual(new Set(['NOT_FOUND']));
	});

	it('folds N distinct UNREGISTERED UPLOAD paths (chunk-0 args header) into one __unknown__ series', async () => {
		const ws = openWs();
		for (let i = 0; i < 15; i++) handleRpc(ws, uploadChunk0Frame(i + 1, 'ghostup/p' + i), env.platform);
		await settle();
		expect(new Set(rpcPaths(reg))).toEqual(new Set(['__unknown__']));
		expect(rpcPaths(reg).length).toBeGreaterThanOrEqual(15);
	});

	it('length-bounds an over-long path AND code to __toolong__ (the single choke-point backstop)', () => {
		_recordRpcMetrics('a'.repeat(200), 'C'.repeat(200), 0);
		expect(reg.series.get('svelte_realtime_rpc_total')[0].labels.path).toBe('__toolong__');
		expect(errSeries(reg)[0].labels).toMatchObject({ path: '__toolong__', code: '__toolong__' });
	});

	it('folds a non-string path to __unknown__ (defensive)', () => {
		_recordRpcMetrics(undefined, '', 0);
		expect(reg.series.get('svelte_realtime_rpc_total')[0].labels.path).toBe('__unknown__');
	});
});
