import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { live, handleRpc, __register, _setSmoothRuntime, _resetSmooth } from '../src/server.js';
import { setRuntimeEnv, resetRuntimeEnv } from '../src/shared/runtime.js';

// The matrix runner changes only the adapter under test, without replacing
// this checkout's dependencies. Missing native support fails instead of skipping.
const legacyRoot = process.env.REALTIME_SMOOTH_LEGACY_ROOT;
const adapterRoot = legacyRoot || fileURLToPath(new URL('../', import.meta.resolve('svelte-adapter-uws')));
const manifest = JSON.parse(readFileSync(resolve(adapterRoot, 'package.json'), 'utf8'));
const adapterModule = key => pathToFileURL(resolve(adapterRoot, manifest.exports[key].default));
const smoothUrl = adapterModule('./plugins/smooth');
const smooth = await import(smoothUrl.href);
const { createTestServer } = await import(adapterModule('./testing').href);
const { parseBinaryFrame } = await import(new URL('../../runtime/wire.js', smoothUrl).href);
const { decodeSmooth, SmoothDecodeDict } = await import(new URL('./codec.js', smoothUrl).href);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) {
	const deadline = Date.now() + 4000;
	while (!check()) {
		if (Date.now() > deadline) throw new Error('Timed out waiting for real smooth delivery');
		await sleep(5);
	}
}

let sequence = 0;
let server, clients, ticks, enqueues;
beforeEach(async () => {
	clients = [];
	ticks = new Map();
	enqueues = [];
	// Hold only the realtime smooth tick. Socket I/O and adapter timers stay real.
	setRuntimeEnv({ timers: {
		set(callback, ms, ...args) {
			if (ms !== 37) return setTimeout(callback, ms, ...args);
			const handle = { unref() {} };
			ticks.set(handle, () => callback(...args));
			return handle;
		},
		clear(handle) { if (!ticks.delete(handle)) clearTimeout(handle); }
	} });
	_setSmoothRuntime({ ...smooth, createSmoothAuthority(options) {
		const authority = smooth.createSmoothAuthority(options);
		const enqueue = authority.enqueue;
		authority.enqueue = (...args) => {
			const result = enqueue(...args);
			if (result) enqueues.push(args);
			return result;
		};
		return authority;
	} });
	server = await createTestServer({ handler: {
		message(ws, ctx) {
			if (!ctx.isBinary && ctx.msg === undefined) handleRpc(ws, ctx.data, server.platform);
		}
	} });
});
afterEach(async () => {
	_resetSmooth();
	_setSmoothRuntime(null);
	resetRuntimeEnv();
	const closed = clients.map(({ ws }) => new Promise((resolve, reject) => {
		if (ws.readyState === WebSocket.CLOSED) return resolve();
		const timer = setTimeout(() => reject(new Error('Smooth test socket did not close')), 2000);
		ws.addEventListener('close', () => { clearTimeout(timer); resolve(); }, { once: true });
		ws.close();
	}));
	await server?.close();
	await Promise.all(closed);
});

async function connect(binary = false) {
	const ws = new WebSocket(server.wsUrl);
	ws.binaryType = 'arraybuffer';
	const json = [], frames = [];
	ws.addEventListener('message', ({ data }) => {
		if (typeof data === 'string') json.push(JSON.parse(data));
		else frames.push(new Uint8Array(data));
	});
	const client = { ws, json, frames };
	clients.push(client);
	await new Promise((resolve, reject) => {
		ws.addEventListener('open', resolve, { once: true });
		ws.addEventListener('error', reject, { once: true });
	});
	if (binary) ws.send(JSON.stringify({ type: 'hello', caps: [smooth.SMOOTH_CAPABILITY] }));
	return client;
}

function rpc(client, path, args) {
	const id = 'installed-' + ++sequence;
	client.ws.send(JSON.stringify({ rpc: path, id, args }));
	return id;
}
const reply = (client, id) => client.json.find(frame => frame.topic === '__rpc' && frame.event === id);
const updates = client => client.json.filter(frame => frame.event === 'update');

describe('smooth wire delivery with adapter ' + manifest.version, () => {
	it.each([false, true])('runs one real multi-entity tick (interest: %s)', async interest => {
		const batched = !legacyRoot;
		if (legacyRoot) expect(manifest.version).toBe('0.6.0-next.61');
		const calls = {};
		for (const name of ['publishWireBatch', 'sendWireBatch']) {
			expect(typeof server.platform[name]).toBe(batched ? 'function' : 'undefined');
			if (batched) calls[name] = vi.spyOn(server.platform, name);
		}
		const name = 'installed' + ++sequence;
		const shape = live.smooth({
			topic: 'installed:' + name, tickMs: 37,
			initial: { x: 0, y: 0 },
			apply: (state, command) => ({ x: state.x + command.dx, y: 0 }),
			...(interest ? { interest: { radius: 100, position: state => state } } : {})
		});
		__register(name + '/sync', shape.__smoothSync, name);
		__register(name + '/command', shape.__smoothCommand, name);
		const [author, secondAuthor, binary, json] = await Promise.all([connect(), connect(), connect(true), connect()]);
		const syncs = clients.map(client => [client, rpc(client, name + '/sync', [])]);
		await until(() => syncs.every(([client, id]) => reply(client, id)));
		for (const [client, id] of syncs) {
			expect(reply(client, id).data.ok).toBe(true);
			client.key = reply(client, id).data.data.you;
		}
		rpc(author, name + '/command', [[{ id: 1, cmd: { dx: 5 } }]]);
		rpc(secondAuthor, name + '/command', [[{ id: 1, cmd: { dx: 7 } }]]);
		await until(() => enqueues.length === 2);
		expect(ticks.size).toBe(1);
		const [handle, tick] = ticks.entries().next().value;
		ticks.delete(handle);
		tick();
		const expectedCount = interest ? 3 : 2;
		await until(() => updates(json).length === expectedCount && binary.frames.length === (batched ? 1 : expectedCount));
		const dict = new SmoothDecodeDict();
		const decoded = binary.frames.map(bytes => {
			const frame = parseBinaryFrame(bytes);
			expect(frame).not.toBeNull();
			const result = decodeSmooth(frame.payload, dict, frame.schemaVersion);
			expect(result).not.toBeNull();
			return result;
		});
		expect(decoded.map(frame => frame.event)).toEqual(batched ? ['update-batch'] : Array(expectedCount).fill('update'));
		const binaryUpdates = decoded.flatMap(frame => frame.event === 'update-batch' ? frame.data.updates : [frame.data]);
		const changed = rows => rows.filter(row => row.key === author.key || row.key === secondAuthor.key).sort((a, b) => a.data.x - b.data.x);
		const expected = [{ key: author.key, data: { x: 5, y: 0 } }, { key: secondAuthor.key, data: { x: 7, y: 0 } }];
		expect(changed(binaryUpdates)).toEqual(expected);
		expect(changed(updates(json).map(frame => frame.data))).toEqual(expected);
		await until(() => author.json.some(frame => frame.event === 'ack') && secondAuthor.json.some(frame => frame.event === 'ack'));
		expect(updates(author).some(frame => frame.data.key === author.key)).toBe(false);
		expect(updates(secondAuthor).some(frame => frame.data.key === secondAuthor.key)).toBe(false);
		if (batched) {
			expect(calls.publishWireBatch).toHaveBeenCalledTimes(interest ? 0 : 1);
			expect(calls.sendWireBatch).toHaveBeenCalledTimes(interest ? 4 : 0);
			if (interest) expect(new Set(calls.sendWireBatch.mock.calls.map(call => call[0])).size).toBe(4);
		}
	});
});
