import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mockWs } from './helpers/mock-ws.js';
import { mockPlatform } from './helpers/mock-platform.js';
import { toArrayBuffer } from './helpers/encode.js';

let api, lifecycle, state, counters, durations;
beforeEach(async () => {
	vi.resetModules();
	api = await import('../src/server.js');
	lifecycle = await import('../src/server/lifecycle.js');
	({ state } = await import('../src/server/state.js'));
	counters = new Map();
	durations = [];
	api.live.metrics({
		counter({ name }) { const rows = []; counters.set(name, rows); return { inc(labels) { rows.push(labels); } }; },
		histogram({ name }) { return { observe(labels) { if (name === 'svelte_realtime_rpc_duration_seconds') durations.push(labels); } }; },
		gauge() { return { inc() {}, dec() {} }; }
	});
	vi.spyOn(console, 'warn').mockImplementation(() => {});
	vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
	lifecycle._resetLifecycle();
	state.serverProtocolVersion = null;
	state.serverProtocolPolicy = null;
	vi.restoreAllMocks();
});

const counts = () => counters.get('svelte_realtime_rpc_total');
const errors = () => counters.get('svelte_realtime_rpc_errors_total');
const flush = () => new Promise(resolve => setTimeout(resolve, 0));
function binary(request) {
	const header = new TextEncoder().encode(JSON.stringify(request));
	const bytes = new Uint8Array(3 + header.length);
	new DataView(bytes.buffer).setUint16(1, header.length);
	bytes.set(header, 3);
	return bytes.buffer;
}
function uploadChunk0(streamId, header) {
	const json = new TextEncoder().encode(JSON.stringify(header));
	const buf = new ArrayBuffer(12 + json.length);
	const view = new DataView(buf);
	view.setUint8(0, 0x01);
	view.setUint8(1, 0x03);
	view.setUint32(2, streamId, false);
	view.setUint32(6, 0, false);
	view.setUint16(10, json.length, false);
	new Uint8Array(buf).set(json, 12);
	return buf;
}
function reply(platform, id) {
	return platform.sent.find(row => row.event === id && row.data?.ok !== undefined)?.data;
}

const frames = {
	text: (path, id) => toArrayBuffer({ rpc: path, id, args: [] }),
	batch: (path, id) => toArrayBuffer({ batch: [{ rpc: path, id, args: [] }] }),
	binary: (path, id) => binary({ rpc: path, id })
};

for (const [kind, frame] of Object.entries(frames)) {
	it(`counts a ${kind} call refused during the drain window as an UNAVAILABLE error`, async () => {
		api.__register('drain/echo', kind === 'binary' ? api.live.binary(() => 'ok') : api.live(() => 'ok'));
		const platform = mockPlatform();
		await lifecycle._runShutdown({ platform });
		expect(api.handleRpc(mockWs({ id: 'u1' }), frame('drain/echo', 'late'), platform)).toBe(true);
		await flush();
		const sent = kind === 'batch' ? platform.sent.at(-1).data.batch[0] : reply(platform, 'late');
		expect(sent).toMatchObject({ ok: false, code: 'UNAVAILABLE' });
		expect(counts()).toEqual([{ path: 'drain/echo', status: 'error' }]);
		expect(errors()).toEqual([{ path: 'drain/echo', code: 'UNAVAILABLE', reason: '', scope: '' }]);
		expect(durations).toEqual([{ path: 'drain/echo' }]);
	});
}

it('folds an unregistered path refused during the drain window to a bounded label', async () => {
	const platform = mockPlatform();
	await lifecycle._runShutdown({ platform });
	api.handleRpc(mockWs({ id: 'u1' }), frames.text('nobody/registered-this', 'a'), platform);
	api.handleRpc(mockWs({ id: 'u1' }), frames.text('../escape', 'b'), platform);
	await flush();
	expect(counts()).toEqual([{ path: '__unknown__', status: 'error' }, { path: '__invalid__', status: 'error' }]);
	expect(errors()).toEqual([{ path: '__unknown__', code: 'UNAVAILABLE', reason: '', scope: '' }, { path: '__invalid__', code: 'UNAVAILABLE', reason: '', scope: '' }]);
});

it('counts an upload refused during the drain window', async () => {
	api.__register('drain/upload', api.live.upload(async () => 'ok'));
	const platform = mockPlatform();
	await lifecycle._runShutdown({ platform });
	api.handleRpc(mockWs({ id: 'u1' }), uploadChunk0(7, { rpc: 'drain/upload', args: [] }), platform);
	await flush();
	expect(platform.sent.at(-1).data).toMatchObject({ ok: false, code: 'UNAVAILABLE' });
	expect(counts()).toEqual([{ path: 'drain/upload', status: 'error' }]);
	expect(errors()).toEqual([{ path: 'drain/upload', code: 'UNAVAILABLE', reason: '', scope: '' }]);
});

it('counts an upload refused at admission once', async () => {
	let release;
	const gate = new Promise(resolve => { release = resolve; });
	api.__register('drain/upload', api.live.upload(async () => { await gate; return 'ok'; }));
	const platform = mockPlatform();
	const ws = mockWs({ id: 'u1' });
	const open = uploadChunk0(9, { rpc: 'drain/upload', args: [] });
	new DataView(open).setUint8(1, 0x01); // has args, not last: the stream stays open
	api.handleRpc(ws, open, platform);
	api.handleRpc(ws, open, platform);
	await flush();
	expect(errors()).toEqual([{ path: 'drain/upload', code: 'INVALID_REQUEST', reason: '', scope: '' }]);
	expect(counts()).toEqual([{ path: 'drain/upload', status: 'error' }]);
	release();
});

for (const kind of ['text', 'binary', 'upload']) {
	it(`counts a ${kind} call refused for a protocol mismatch`, async () => {
		state.serverProtocolVersion = 3;
		state.serverProtocolPolicy = { current: 3, minimum: 2, onMismatch: 'reject' };
		const path = 'protocol/' + kind;
		api.__register(path, kind === 'binary' ? api.live.binary(() => 'ok') : kind === 'upload' ? api.live.upload(async () => 'ok') : api.live(() => 'ok'));
		const platform = mockPlatform();
		const data = kind === 'upload' ? uploadChunk0(3, { rpc: path, args: [] }) : frames[kind](path, 'p');
		api.handleRpc(mockWs({ id: 'u1' }), data, platform);
		await flush();
		expect(platform.sent.find(row => row.data?.code === 'PROTOCOL_MISMATCH')).toBeTruthy();
		expect(counts()).toEqual([{ path, status: 'error' }]);
		expect(errors()).toEqual([{ path, code: 'PROTOCOL_MISMATCH', reason: '', scope: '' }]);
	});
}

it('does not count upload continuation frames refused for a protocol mismatch', async () => {
	state.serverProtocolVersion = 3;
	state.serverProtocolPolicy = { current: 3, minimum: 2, onMismatch: 'reject' };
	const platform = mockPlatform();
	const later = uploadChunk0(3, { rpc: 'protocol/upload', args: [] });
	new DataView(later).setUint32(6, 1, false);
	api.handleRpc(mockWs({ id: 'u1' }), later, platform);
	await flush();
	expect(counts()).toEqual([]);
});

function uploadContinuation(seq, bytes = 0, last = false) {
	const buf = new ArrayBuffer(10 + bytes);
	const view = new DataView(buf);
	view.setUint8(0, 1);
	view.setUint8(1, last ? 2 : 0);
	view.setUint32(2, 17);
	view.setUint32(6, seq);
	return buf;
}
function cancelUpload() {
	const bytes = new Uint8Array(6);
	bytes[0] = 2; bytes[1] = 16;
	new DataView(bytes.buffer).setUint32(2, 17);
	return bytes.buffer;
}
function openUpload(ws, platform, path = 'outcome/upload') {
	const start = uploadChunk0(17, { rpc: path, args: [] });
	new DataView(start).setUint8(1, 1);
	api.handleRpc(ws, start, platform);
}
for (const terminal of ['sequence', 'cancel', 'buffer', 'disconnect']) {
	it('records one upload outcome before lookup resumes: ' + terminal, async () => {
		const handler = vi.fn(async () => 'ok');
		api.__register('outcome/upload', api.live.upload(handler));
		const ws = mockWs({ id: 'u1' }), platform = mockPlatform();
		openUpload(ws, platform);
		if (terminal === 'sequence') api.handleRpc(ws, uploadContinuation(2), platform);
		if (terminal === 'cancel') api.handleRpc(ws, cancelUpload(), platform);
		if (terminal === 'buffer') for (let seq = 1; seq <= 64; seq++) api.handleRpc(ws, uploadContinuation(seq), platform);
		if (terminal === 'disconnect') api.close(ws, { platform, subscriptions: [] });
		const code = { sequence: 'INVALID_REQUEST', cancel: 'CANCELLED', buffer: 'FLOW_BACKPRESSURE', disconnect: 'DISCONNECTED' }[terminal];
		expect(counts()).toEqual([{ path: 'outcome/upload', status: 'error' }]);
		expect(errors()).toEqual([{ path: 'outcome/upload', code, reason: '', scope: '' }]);
		expect(durations).toEqual([{ path: 'outcome/upload' }]);
		await flush();
		expect(handler).not.toHaveBeenCalled();
		expect(counts()).toHaveLength(1);
		expect(errors()).toHaveLength(1);
		expect(durations).toHaveLength(1);
	});
}
it('keeps a pending unknown upload path bounded when cancellation wins lookup', async () => {
	const ws = mockWs({ id: 'u1' }), platform = mockPlatform();
	openUpload(ws, platform, 'attacker/unknown-value');
	api.handleRpc(ws, cancelUpload(), platform);
	await flush();
	expect(counts()).toEqual([{ path: '__unknown__', status: 'error' }]);
	expect(errors()).toEqual([{ path: '__unknown__', code: 'CANCELLED', reason: '', scope: '' }]);
});
for (const stage of ['guard', 'handler']) {
	it('keeps the original cancellation outcome when a delayed ' + stage + ' resolves', async () => {
		let release, entered;
		const gate = new Promise(resolve => { release = resolve; });
		const waiting = new Promise(resolve => { entered = resolve; });
		api.__registerGuard('outcome', api.guard(async () => {
			if (stage === 'guard') { entered(); await gate; }
		}));
		const handler = vi.fn(async () => {
			if (stage === 'handler') { entered(); await gate; }
			return 'ignored abort';
		});
		api.__register('outcome/upload', api.live.upload(handler));
		const ws = mockWs({ id: 'u1' }), platform = mockPlatform();
		try {
			openUpload(ws, platform);
			await waiting;
			api.handleRpc(ws, cancelUpload(), platform);
			expect(counts()).toEqual([{ path: 'outcome/upload', status: 'error' }]);
			expect(errors()).toEqual([{ path: 'outcome/upload', code: 'CANCELLED', reason: '', scope: '' }]);
			release(); await flush();
			expect(counts()).toHaveLength(1);
			expect(errors()).toHaveLength(1);
			expect(durations).toHaveLength(1);
			expect(platform.sent.filter(row => row.topic === '__upload')).toHaveLength(1);
			if (stage === 'guard') expect(handler).not.toHaveBeenCalled();
		} finally { release(); }
	});
}

for (const afterReply of ['close', 'throw']) {
	it('keeps a successful upload outcome when middleware delays and then ' + afterReply + ' occurs', async () => {
		let release, entered;
		const gate = new Promise(resolve => { release = resolve; });
		const waiting = new Promise(resolve => { entered = resolve; });
		api.live.middleware(async (_ctx, next) => {
			await next();
			entered();
			await gate;
			if (afterReply === 'throw') throw Error('post-response cleanup failed');
		});
		api.__register('outcome/upload', api.live.upload(async () => 'uploaded'));
		const ws = mockWs({ id: 'u1' }), platform = mockPlatform();
		try {
			api.handleRpc(ws, uploadChunk0(17, { rpc: 'outcome/upload', args: [] }), platform);
			await waiting;
			expect(platform.sent.find(row => row.topic === '__upload').data).toMatchObject({ ok: true, data: 'uploaded' });
			if (afterReply === 'close') api.close(ws, { platform, subscriptions: [] });
			release(); await flush();
			expect(counts()).toEqual([{ path: 'outcome/upload', status: 'ok' }]);
			expect(errors()).toEqual([]);
			expect(durations).toEqual([{ path: 'outcome/upload' }]);
			expect(platform.sent.filter(row => row.topic === '__upload')).toHaveLength(1);
		} finally { release(); }
	});
}

for (const outcome of ['success', 'cancel', 'drain']) {
	it('labels a credit-mode upload once at ' + outcome, async () => {
		api.__register('credit/upload', api.live.upload(async () => 'ok'));
		const ws = mockWs({ id: 'u1' }), platform = mockPlatform();
		if (outcome === 'drain') await lifecycle._runShutdown({ platform });
		api.handleRpc(ws, uploadChunk0(17, { path: 'credit/upload', args: [] }), platform);
		if (outcome === 'cancel') api.handleRpc(ws, cancelUpload(), platform);
		await flush();
		const code = outcome === 'success' ? null : outcome === 'cancel' ? 'CANCELLED' : 'UNAVAILABLE';
		expect(counts()).toEqual([{ path: 'credit/upload', status: code ? 'error' : 'ok' }]);
		expect(errors()).toEqual(code ? [{ path: 'credit/upload', code, reason: '', scope: '' }] : []);
		expect(durations).toEqual([{ path: 'credit/upload' }]);
	});
}
it('does not label an ambiguous credit header as either registered endpoint', async () => {
	api.__register('credit/upload', api.live.upload(async () => 'ok'));
	const platform = mockPlatform();
	api.handleRpc(mockWs({ id: 'u1' }), uploadChunk0(17, { path: 'credit/upload', rpc: 'credit/upload' }), platform);
	await flush();
	expect(counts()).toEqual([{ path: '__invalid__', status: 'error' }]);
	expect(errors()).toEqual([{ path: '__invalid__', code: 'INVALID_REQUEST', reason: '', scope: '' }]);
});

it.each([false, true])('bounds credit header labels on protocol refusal (ambiguous: %s)', async ambiguous => {
	state.serverProtocolVersion = 3;
	state.serverProtocolPolicy = { current: 3, minimum: 2, onMismatch: 'reject' };
	api.__register('credit/upload', api.live.upload(async () => 'ok'));
	const platform = mockPlatform();
	const header = { path: 'credit/upload', ...(ambiguous ? { rpc: 'credit/upload' } : {}) };
	api.handleRpc(mockWs({ id: 'u1' }), uploadChunk0(17, header), platform);
	await flush();
	const path = ambiguous ? '__invalid__' : 'credit/upload';
	expect(counts()).toEqual([{ path, status: 'error' }]);
	expect(errors()).toEqual([{ path, code: 'PROTOCOL_MISMATCH', reason: '', scope: '' }]);
});
