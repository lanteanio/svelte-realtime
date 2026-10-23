import { afterEach, describe, expect, it, vi } from 'vitest';
import { writable } from 'svelte/store';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

// The real browser client (svelte-realtime/client) talks to the real server
// dispatcher through createTestEnv: the adapter's client transport is replaced
// by a bridge that hands every frame to `sendRaw` and routes every direct
// server message back to the client's topic listeners. The adapter mock is
// registered once and delegates to the current test's bridge, since a mocked
// module instance can outlive vi.resetModules().
const bridge = vi.hoisted(() => ({ connection: /** @type {any} */ (null) }));
vi.mock('svelte-adapter-uws/client', () => ({
	connect: () => bridge.connection,
	status: { subscribe: (fn) => bridge.connection.status.subscribe(fn) },
	setTopicManaged: () => {}
}));

const vectors = JSON.parse(readFileSync(new URL('../docs/upload-wire-v1.json', import.meta.url), 'utf8'));
const wireDoc = readFileSync(new URL('../docs/upload-wire.md', import.meta.url), 'utf8');

/** @param {string} name */
function vector(name) {
	const v = vectors.vectors.find((entry) => entry.name === name);
	if (!v) throw new Error('missing vector ' + name);
	return v;
}

/** @param {string} hex */
function bytesOf(hex) {
	return Uint8Array.from(Buffer.from(hex, 'hex'));
}

/** Decode an upload frame independently of the client encoder. */
function decodeFrame(buf) {
	const u8 = new Uint8Array(buf);
	const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
	if (u8[0] === 0x02) return { frame: 'cancel', ctrl: u8[1], streamId: view.getUint32(2), length: u8.byteLength };
	const flags = u8[1];
	const hasArgs = (flags & 1) !== 0;
	let header = null;
	let offset = 10;
	if (hasArgs) {
		const len = view.getUint16(10);
		header = JSON.parse(new TextDecoder().decode(u8.subarray(12, 12 + len)));
		offset = 12 + len;
	}
	return {
		frame: 'chunk', flags, hasArgs, isLast: (flags & 2) !== 0,
		streamId: view.getUint32(2), seq: view.getUint32(6),
		header, payload: Buffer.from(u8.subarray(offset)).toString('hex'), length: u8.byteLength
	};
}

let env, peer;
afterEach(() => {
	peer?.disconnect();
	env?.cleanup();
	env = peer = undefined;
});

/**
 * @param {{ frameSize?: number, legacyServer?: boolean }} [options]
 *   legacyServer: answer `path` headers the way a server without receiver
 *   credits does, before they reach the dispatcher.
 */
async function setup({ frameSize = 256 * 1024, legacyServer = false } = {}) {
	vi.resetModules();
	const topics = new Map();
	const status = writable('open');
	/** @type {any[]} */
	const frames = [];
	const deliver = (topic, event, data) => {
		for (const cb of [...(topics.get(topic) || [])]) cb({ event, data });
	};
	const connection = {
		status, failure: writable(null), denials: writable(null), bufferedAmount: 0,
		onRequest: () => () => {},
		on(topic) {
			return {
				subscribe(fn) {
					if (!topics.has(topic)) topics.set(topic, new Set());
					topics.get(topic).add(fn);
					return () => topics.get(topic).delete(fn);
				}
			};
		},
		sendQueued(frame) {
			if (frame instanceof ArrayBuffer) {
				const decoded = decodeFrame(frame);
				frames.push({ ...decoded, hex: Buffer.from(new Uint8Array(frame)).toString('hex') });
				if (legacyServer && decoded.hasArgs && typeof decoded.header.path === 'string') {
					const hex = decoded.streamId.toString(16).padStart(8, '0');
					queueMicrotask(() => deliver('__upload', hex, { ok: false, code: 'INVALID_REQUEST', error: 'missing rpc path', requestId: hex }));
					return;
				}
				return peer.sendRaw(frame);
			}
			return peer.sendRaw(new TextEncoder().encode(JSON.stringify(frame)).buffer);
		}
	};
	connection.send = connection.sendQueued;
	bridge.connection = connection;
	const { createTestEnv } = await import('../src/testing.js');
	const server = await import('../src/server.js');
	const client = await import('../src/client.js');
	env = createTestEnv();
	env.platform.maxPayloadLength = frameSize;
	peer = env.connect({ id: 'u1' });
	/** @type {any[]} */
	const uploadEnvelopes = [];
	const attach = (p) => p.onMessage(({ topic, event, data }) => {
		if (topic === '__upload') uploadEnvelopes.push(data);
		deliver(topic, event, data);
	});
	attach(peer);
	const chunks = () => frames.filter((f) => f.frame === 'chunk');
	return { ...server, ...client, frames, chunks, uploadEnvelopes, status, attach };
}

/** Handler that counts bytes, optionally pausing per chunk. */
function counting(live, delayMs = 0, options) {
	return live.upload(async (ctx) => {
		let bytes = 0;
		for await (const chunk of ctx.stream) {
			bytes += chunk.byteLength;
			if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
		}
		return bytes;
	}, options);
}

describe('upload receiver credits through the real client and server', () => {
	it('delivers 256 MiB to a 1 ms-per-chunk consumer with default options', async () => {
		const ctx = await setup();
		const total = 256 * 1024 * 1024;
		const expected = createHash('sha256');
		const block = new Uint8Array(64 * 1024).map((_, i) => (i * 7) % 251);
		let remaining = total;
		const source = new ReadableStream({
			pull(controller) {
				if (remaining === 0) { controller.close(); return; }
				const piece = block.slice();
				piece[0] = remaining & 0xff;
				expected.update(piece);
				remaining -= piece.byteLength;
				controller.enqueue(piece);
			}
		});
		env.register('files', {
			save: ctx.live.upload(async (uctx) => {
				const hash = createHash('sha256');
				let bytes = 0;
				for await (const chunk of uctx.stream) {
					hash.update(chunk);
					bytes += chunk.byteLength;
					await new Promise((resolve) => setTimeout(resolve, 1));
				}
				return { bytes, digest: hash.digest('hex') };
			}, { maxSize: total })
		});

		const result = await ctx.__upload('files/save')(source);
		expect(result).toEqual({ bytes: total, digest: expected.digest('hex') });

		const sent = ctx.chunks();
		const headerLen = JSON.stringify({ path: 'files/save' }).length;
		// Fresh connection, nothing called before: chunk 0 fills the 12 KiB
		// default frame; the first grant carries the cap and chunk 1 uses it.
		expect(sent[0].length).toBe(12 * 1024);
		expect(sent[1].length).toBe(256 * 1024 - 2 - headerLen);
		expect(sent.every((f) => f.length <= 256 * 1024)).toBe(true);
		// The whole stream rode receiver credits, granted per half window.
		const grants = ctx.uploadEnvelopes.filter((e) => e.flow === 1);
		expect(grants.length).toBeGreaterThan(1);
		expect(grants.length).toBeLessThan(sent.length / 16);
		expect(ctx.uploadEnvelopes.some((e) => e.code === 'FLOW_BACKPRESSURE')).toBe(false);
	}, 60_000);

	it('sizes chunk 0 from a cap announced by an earlier RPC response', async () => {
		const ctx = await setup({ frameSize: 4096 });
		env.register('files', { ping: ctx.live(async () => 'pong'), save: counting(ctx.live) });
		expect(await ctx.__rpc('files/ping')()).toBe('pong');
		expect(await ctx.__upload('files/save')(new Uint8Array(20_000))).toBe(20_000);
		const sent = ctx.chunks();
		expect(sent[0].length).toBe(4096);
		expect(sent.every((f) => f.length <= 4096)).toBe(true);
		expect(sent.slice(1, -1).every((f) => f.length === 4096 - 2 - JSON.stringify({ path: 'files/save' }).length)).toBe(true);
	});

	it('announces the cap on RPC responses only once per connection and only with an upload endpoint', async () => {
		const ctx = await setup({ frameSize: 4096 });
		const rpc = [];
		peer.onMessage(({ topic, data }) => { if (topic === '__rpc') rpc.push(data); });
		env.register('plain', { ping: ctx.live(async () => 'pong') });
		await ctx.__rpc('plain/ping')();
		expect(rpc[0]).not.toHaveProperty('__cap');
		env.register('files', { save: counting(ctx.live) });
		await ctx.__rpc('plain/ping')();
		await ctx.__rpc('plain/ping')();
		expect(rpc.slice(1).map((r) => r.__cap)).toEqual([4096, undefined]);
	});

	it('sends only chunk 0 until authorization grants credit, then completes', async () => {
		const ctx = await setup({ frameSize: 1024 });
		let release;
		const gate = new Promise((resolve) => { release = resolve; });
		env.register('files', {
			_guard: ctx.guard(async () => { await gate; }),
			save: counting(ctx.live, 1, { maxBufferedChunks: 1 })
		});
		const handle = ctx.__upload('files/save')(new Uint8Array(20_000));
		const progress = [];
		handle.on('progress', (p) => progress.push(p.sent));
		await new Promise((resolve) => setTimeout(resolve, 30));
		expect(ctx.chunks()).toHaveLength(1);
		expect(progress).toEqual([]);
		release();
		expect(await handle).toBe(20_000);
		expect(progress.at(-1)).toBe(20_000);
		expect(ctx.uploadEnvelopes.some((e) => e.code === 'FLOW_BACKPRESSURE')).toBe(false);
	});

	it('cancel wakes a credit-blocked sender and releases the source reader', async () => {
		const ctx = await setup({ frameSize: 1024 });
		let entered, release;
		const started = new Promise((resolve) => { entered = resolve; });
		const gate = new Promise((resolve) => { release = resolve; });
		env.register('files', {
			save: ctx.live.upload(async (uctx) => {
				entered();
				await gate;
				for await (const chunk of uctx.stream) void chunk;
			}, { maxBufferedChunks: 1 })
		});
		const source = new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(1024)); } });
		const handle = ctx.__upload('files/save')(source);
		await started;
		await new Promise((resolve) => setTimeout(resolve, 10));
		// A one-chunk window full with chunk 0: no grant, nothing more sent.
		expect(ctx.chunks()).toHaveLength(1);
		expect(ctx.uploadEnvelopes.filter((e) => e.flow === 1)).toEqual([]);
		handle.cancel();
		await expect(handle).rejects.toMatchObject({ code: 'CANCELLED' });
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(source.locked).toBe(false);
		expect(ctx.chunks()).toHaveLength(1);
		expect(ctx.frames.at(-1)).toMatchObject({ frame: 'cancel', ctrl: 0x10 });
		release();
	});

	it('falls back to the rpc header once per connection against a server without credits', async () => {
		const ctx = await setup({ legacyServer: true, frameSize: 64 * 1024 });
		env.register('files', { save: counting(ctx.live) });
		const handle = ctx.__upload('files/save')(new Uint8Array(30_000));
		const progress = [];
		handle.on('progress', (p) => progress.push(p.sent));
		expect(await handle).toBe(30_000);
		const first = ctx.chunks();
		expect(first[0].header).toEqual({ path: 'files/save' });
		expect(first[1]).toMatchObject({ seq: 0, header: { rpc: 'files/save' } });
		expect(first.slice(1).map((f) => f.seq)).toEqual(first.slice(1).map((_, i) => i));
		// Progress counts the accepted bytes once, never the refused attempt.
		expect(progress.at(-1)).toBe(30_000);
		expect(progress.every((sent, i) => i === 0 || sent > progress[i - 1])).toBe(true);

		ctx.frames.length = 0;
		expect(await ctx.__upload('files/save')(new Uint8Array(5))).toBe(5);
		expect(ctx.chunks().map((f) => f.header && Object.keys(f.header))).toEqual([['rpc']]);

		// A new socket may reach an upgraded server: credits are tried again.
		ctx.status.set('disconnected');
		ctx.status.set('open');
		ctx.frames.length = 0;
		expect(await ctx.__upload('files/save')(new Uint8Array(5))).toBe(5);
		expect(ctx.chunks()[0].header).toEqual({ path: 'files/save' });
	});

	it.each(['FORBIDDEN', 'UNAUTHENTICATED'])('runs the guard for the resent upload (%s)', async (code) => {
		const ctx = await setup({ legacyServer: true });
		let ran = false;
		env.register('private', {
			_guard: ctx.guard(() => { throw new ctx.LiveError(code, 'Access denied'); }),
			save: ctx.live.upload(async () => { ran = true; return 1; })
		});
		await expect(ctx.__upload('private/save')(new Uint8Array([1]))).rejects.toMatchObject({ code });
		expect(ran).toBe(false);
	});

	it('resends the rpc header without encoding the arguments again', async () => {
		const ctx = await setup({ legacyServer: true });
		let received;
		env.register('files', {
			save: ctx.live.upload(async (c, label) => {
				received = label;
				for await (const _ of c.stream) { /* drain */ }
				return 'saved';
			})
		});
		let encodings = 0;
		const label = {
			toJSON() {
				if (++encodings > 1) throw new TypeError('second encoding');
				return 'ok';
			}
		};
		const handle = ctx.__upload('files/save')(new Uint8Array([1, 2, 3]), label);
		expect(await handle).toBe('saved');
		expect(encodings).toBe(1);
		expect(received).toBe('ok');
		const headers = ctx.chunks().filter((f) => f.hasArgs).map((f) => f.header);
		expect(headers).toEqual([{ path: 'files/save', args: ['ok'] }, { rpc: 'files/save', args: ['ok'] }]);
	});

	it('rejects an upload whose arguments cannot be encoded without sending it', async () => {
		const ctx = await setup();
		env.register('files', { save: counting(ctx.live) });
		const cyclic = {};
		cyclic.self = cyclic;
		const handle = ctx.__upload('files/save')(new Uint8Array([1]), cyclic);
		const errors = [];
		handle.on('error', (e) => errors.push(e));
		const err = await handle.then(() => null, (e) => e);
		expect(err).toMatchObject({ code: 'INVALID_REQUEST', message: 'Upload request could not be encoded' });
		expect(err.cause).toBeInstanceOf(TypeError);
		expect(errors).toEqual([err]);
		expect(ctx.frames).toEqual([]);
		// The connection stays usable for the next upload.
		expect(await ctx.__upload('files/save')(new Uint8Array(4))).toBe(4);
	});

	it('rejects upload arguments that do not fit the 16-bit header length', async () => {
		const ctx = await setup();
		env.register('files', { save: counting(ctx.live) });
		const err = await ctx.__upload('files/save')(new Uint8Array([1]), 'x'.repeat(70_000)).then(() => null, (e) => e);
		expect(err).toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
		expect(ctx.frames).toEqual([]);
		const fits = 'x'.repeat(65_535 - JSON.stringify({ path: 'files/save', args: [''] }).length);
		expect(await ctx.__upload('files/save')(new Uint8Array(4), fits)).toBe(4);
	});

	it('rejects upload arguments that leave chunk 0 no room under the known frame cap', async () => {
		const ctx = await setup({ frameSize: 4096 });
		env.register('files', { ping: ctx.live(async () => 'pong'), save: counting(ctx.live) });
		await ctx.__rpc('files/ping')();
		const room = 4096 - 12 - 1 - JSON.stringify({ path: 'files/save', args: [''] }).length;
		const err = await ctx.__upload('files/save')(new Uint8Array([1]), 'x'.repeat(room + 1)).then(() => null, (e) => e);
		expect(err).toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
		expect(ctx.chunks()).toEqual([]);
		expect(await ctx.__upload('files/save')(new Uint8Array(3), 'x'.repeat(room))).toBe(3);
		expect(ctx.chunks().every((f) => f.length <= 4096)).toBe(true);
	});

	it('sends an empty upload whose header exactly fills the known frame cap', async () => {
		const ctx = await setup({ frameSize: 4096 });
		env.register('files', { ping: ctx.live(async () => 'pong'), save: counting(ctx.live) });
		await ctx.__rpc('files/ping')();
		const exact = 'x'.repeat(4096 - 12 - JSON.stringify({ path: 'files/save', args: [''] }).length);
		expect(await ctx.__upload('files/save')(new Uint8Array(0), exact)).toBe(0);
		expect(ctx.chunks().map((f) => [f.length, f.isLast])).toEqual([[4096, true]]);
		const err = await ctx.__upload('files/save')(new Uint8Array(0), exact + 'x').then(() => null, (e) => e);
		expect(err).toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
		expect(ctx.chunks()).toHaveLength(1);
	});

	it('relearns the frame cap after reconnecting', async () => {
		const ctx = await setup({ frameSize: 8192 });
		env.register('files', { ping: ctx.live(async () => 'pong'), save: counting(ctx.live) });
		await ctx.__rpc('files/ping')();
		expect(await ctx.__upload('files/save')(new Uint8Array(1))).toBe(1);
		expect(ctx.chunks()[0].length).toBe(12 + JSON.stringify({ path: 'files/save' }).length + 1);

		ctx.status.set('disconnected');
		peer.disconnect();
		peer = env.connect({ id: 'u1' });
		ctx.attach(peer);
		ctx.status.set('open');
		ctx.frames.length = 0;
		expect(await ctx.__upload('files/save')(new Uint8Array(30_000))).toBe(30_000);
		// The old socket's cap is forgotten: chunk 0 on the new socket uses
		// the 12 KiB default, and the new socket's announcement (8192, in the
		// first grant) sizes every later chunk.
		const sent = ctx.chunks();
		expect(sent[0].length).toBe(12 * 1024);
		expect(sent.slice(1).every((f) => f.length <= 8192)).toBe(true);
		expect(sent[1].length).toBe(8192 - 2 - JSON.stringify({ path: 'files/save' }).length);
	});
});

describe('upload wire vectors', () => {
	it('documents every vector and decodes each to its described fields', () => {
		expect(vectors.version).toBe(1);
		expect(wireDoc).toContain('upload-wire-v1.json');
		for (const v of vectors.vectors) {
			expect(wireDoc).toContain('`' + v.name + '`');
			const decoded = decodeFrame(bytesOf(v.hex));
			expect(decoded.frame).toBe(v.frame);
			expect(decoded.streamId).toBe(v.streamId);
			if (v.frame === 'cancel') {
				expect(decoded).toMatchObject({ ctrl: 0x10, length: 6 });
				continue;
			}
			expect(decoded).toMatchObject({ seq: v.seq, hasArgs: v.hasArgs, isLast: v.isLast, header: v.header, payload: v.payload });
			expect(decoded.flags & 0xfc).toBe(0);
		}
	});

	it('matches the frames the browser client encodes', async () => {
		const ctx = await setup();
		env.register('files', { save: counting(ctx.live) });
		// Frames sized for three payload bytes each, as in the vectors.
		ctx.configure({ upload: { frameSize: 12 + JSON.stringify({ path: 'files/save' }).length + 3 } });
		const handle = ctx.__upload('files/save')(new ReadableStream({
			start(controller) {
				controller.enqueue(bytesOf('000102'));
				setTimeout(() => { controller.enqueue(bytesOf('03feff')); controller.close(); }, 5);
			}
		}));
		expect(handle.streamId).toBe(1);
		expect(await handle).toBe(6);
		expect(ctx.frames.map((f) => f.hex)).toEqual([vector('first').hex, vector('last').hex]);
	});

	it('runs the vectors through the real dispatcher', async () => {
		const ctx = await setup();
		env.register('files', {
			save: ctx.live.upload(async (uctx) => {
				const bytes = [];
				for await (const chunk of uctx.stream) bytes.push(...chunk);
				return Buffer.from(bytes).toString('hex');
			})
		});
		const responses = ctx.uploadEnvelopes;
		peer.sendRaw(bytesOf(vector('first').hex).buffer);
		await new Promise((resolve) => setTimeout(resolve, 0));
		const grant = responses.find((r) => r.flow === 1);
		expect(grant.creditEnd).toBeGreaterThanOrEqual(2);
		peer.sendRaw(bytesOf(vector('last').hex).buffer);
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(responses.at(-1)).toEqual({ ok: true, data: '000102' + '03feff' });

		peer.sendRaw(bytesOf(vector('legacy').hex).buffer);
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(responses.at(-1)).toEqual({ ok: true, data: '000102' });

		peer.sendRaw(bytesOf(vector('first').hex).buffer);
		await new Promise((resolve) => setTimeout(resolve, 0));
		peer.sendRaw(bytesOf(vector('cancel').hex).buffer);
		expect(responses.at(-1)).toMatchObject({ ok: false, code: 'CANCELLED' });
	});
});

describe('senders that ignore the pause', () => {
	it('fails a chunk sent before any grant while authorization is pending', async () => {
		const ctx = await setup();
		let release;
		const gate = new Promise((resolve) => { release = resolve; });
		let ran = false;
		env.register('files', {
			_guard: ctx.guard(async () => { await gate; }),
			save: ctx.live.upload(async () => { ran = true; return 1; })
		});
		peer.sendRaw(bytesOf(vector('first').hex).buffer);
		peer.sendRaw(bytesOf(vector('last').hex).buffer);
		expect(ctx.uploadEnvelopes.at(-1)).toMatchObject({ ok: false, code: 'FLOW_BACKPRESSURE', error: 'upload chunk exceeds receiver credit' });
		release();
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(ran).toBe(false);
	});

	it('fails a chunk past the granted bound while the handler is not draining', async () => {
		const ctx = await setup();
		let aborted = null;
		env.register('files', {
			save: ctx.live.upload(async (uctx) => {
				await new Promise((resolve) => uctx.abortSignal.addEventListener('abort', resolve, { once: true }));
				aborted = uctx.abortSignal.reason;
			}, { maxBufferedChunks: 2 })
		});
		const chunk = (seq) => {
			const buf = new Uint8Array(13);
			const view = new DataView(buf.buffer);
			buf[0] = 0x01;
			view.setUint32(2, 7);
			view.setUint32(6, seq);
			buf.set([1, 2, 3], 10);
			return buf.buffer;
		};
		const header = new TextEncoder().encode(JSON.stringify({ path: 'files/save' }));
		const first = new Uint8Array(12 + header.length + 1);
		const fv = new DataView(first.buffer);
		first[0] = 0x01; first[1] = 0x01; fv.setUint32(2, 7); fv.setUint16(10, header.length); first.set(header, 12);
		peer.sendRaw(first.buffer);
		await new Promise((resolve) => setTimeout(resolve, 0));
		const grant = ctx.uploadEnvelopes.find((e) => e.flow === 1);
		expect(grant).toEqual(expect.objectContaining({ flow: 1, creditEnd: 2 }));
		peer.sendRaw(chunk(1));
		expect(ctx.uploadEnvelopes.filter((e) => e.ok === false)).toEqual([]);
		peer.sendRaw(chunk(2));
		expect(ctx.uploadEnvelopes.at(-1)).toMatchObject({ ok: false, code: 'FLOW_BACKPRESSURE', error: 'upload chunk exceeds receiver credit' });
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(aborted).toMatchObject({ code: 'FLOW_BACKPRESSURE' });
	});

	it('rejects a non-positive receiver window at declaration', async () => {
		const ctx = await setup();
		for (const bad of [0, -1, 1.5, Number.NaN, '4']) {
			expect(() => ctx.live.upload(async () => 1, { maxBufferedChunks: /** @type {any} */ (bad) })).toThrow(/maxBufferedChunks/);
		}
	});
});

describe('upload stream diagnostics', () => {
	/** @param {any} ctx */
	function capture(ctx) {
		const records = [];
		const restore = ctx.setOperationalEventSink((record) => { records.push(record); });
		const stream = () => records.filter((r) => r.event.startsWith('upload.stream.'));
		return { records, stream, restore };
	}

	it('pairs one started with one completed record for a finished upload', async () => {
		const ctx = await setup({ frameSize: 4096 });
		const sink = capture(ctx);
		try {
			env.register('files', { save: counting(ctx.live, 0, { diagnostics: true }) });
			const handle = ctx.__upload('files/save')(new Uint8Array(30_000).fill(0xab));
			expect(await handle).toBe(30_000);
			const [started, ended, ...rest] = sink.stream();
			expect(rest).toEqual([]);
			expect(started).toMatchObject({
				event: 'upload.stream.started', severity: 'debug', dataClass: 'pseudonymous',
				attributes: { path: 'files/save', streamId: handle.streamIdHex, credits: true }
			});
			expect(ended).toMatchObject({
				event: 'upload.stream.ended', severity: 'debug', dataClass: 'pseudonymous',
				attributes: { path: 'files/save', streamId: handle.streamIdHex, outcome: 'completed', code: null, bytes: 30_000, chunks: ctx.chunks().length }
			});
			expect(Number.isInteger(ended.attributes.durationMs) && ended.attributes.durationMs >= 0).toBe(true);
			expect(JSON.stringify(sink.stream())).not.toMatch(/abab|171,171/);
		} finally { sink.restore(); }
	});

	it('pairs one started with one cancelled record for a cancelled upload', async () => {
		const ctx = await setup({ frameSize: 1024 });
		const sink = capture(ctx);
		try {
			let entered;
			const started = new Promise((resolve) => { entered = resolve; });
			env.register('files', {
				save: ctx.live.upload(async (uctx) => {
					entered();
					for await (const chunk of uctx.stream) await new Promise((resolve) => setTimeout(resolve, 5, chunk));
				}, { diagnostics: true })
			});
			const handle = ctx.__upload('files/save')(new ReadableStream({ pull(c) { c.enqueue(new Uint8Array(512)); } }));
			await started;
			await new Promise((resolve) => setTimeout(resolve, 20));
			handle.cancel();
			await expect(handle).rejects.toMatchObject({ code: 'CANCELLED' });
			await new Promise((resolve) => setTimeout(resolve, 20));
			expect(sink.stream().map((r) => [r.event, r.attributes.outcome])).toEqual([
				['upload.stream.started', undefined],
				['upload.stream.ended', 'cancelled']
			]);
			expect(sink.stream()[1].attributes.code).toBe('CANCELLED');
		} finally { sink.restore(); }
	});

	it('emits nothing for an endpoint without diagnostics', async () => {
		const ctx = await setup();
		const sink = capture(ctx);
		try {
			env.register('files', { save: counting(ctx.live), slow: counting(ctx.live, 5) });
			expect(await ctx.__upload('files/save')(new Uint8Array(1000))).toBe(1000);
			const handle = ctx.__upload('files/slow')(new ReadableStream({ pull(c) { c.enqueue(new Uint8Array(512)); } }));
			await new Promise((resolve) => setTimeout(resolve, 10));
			handle.cancel();
			await expect(handle).rejects.toMatchObject({ code: 'CANCELLED' });
			expect(sink.stream()).toEqual([]);
		} finally { sink.restore(); }
	});

	it('names the outcome of every other ending once', async () => {
		const ctx = await setup();
		const sink = capture(ctx);
		try {
			let release;
			const gate = new Promise((resolve) => { release = resolve; });
			env.register('slow', { _guard: ctx.guard(async () => { await gate; }), save: ctx.live.upload(async () => 1, { diagnostics: true }) });
			env.register('denied', { _guard: ctx.guard(() => { throw new ctx.LiveError('FORBIDDEN', 'no'); }), save: ctx.live.upload(async () => 1, { diagnostics: true }) });
			env.register('broken', { save: ctx.live.upload(async () => { throw new Error('disk full'); }, { diagnostics: true }) });
			env.register('files', { save: ctx.live.upload(async (uctx) => { for await (const c of uctx.stream) void c; }, { diagnostics: true }) });
			const first = (streamId, path) => {
				const header = new TextEncoder().encode(JSON.stringify({ path }));
				const buf = new Uint8Array(12 + header.length + 1);
				const view = new DataView(buf.buffer);
				buf[0] = 0x01; buf[1] = 0x01; view.setUint32(2, streamId); view.setUint16(10, header.length); buf.set(header, 12);
				return buf.buffer;
			};
			const next = (streamId, seq) => {
				const buf = new Uint8Array(11);
				const view = new DataView(buf.buffer);
				buf[0] = 0x01; view.setUint32(2, streamId); view.setUint32(6, seq);
				return buf.buffer;
			};
			peer.sendRaw(first(1, 'slow/save'));
			await new Promise((resolve) => setTimeout(resolve, 0));
			peer.sendRaw(next(1, 1));
			release();
			peer.sendRaw(first(2, 'denied/save'));
			peer.sendRaw(first(3, 'broken/save'));
			peer.sendRaw(first(4, 'files/save'));
			await new Promise((resolve) => setTimeout(resolve, 10));
			peer.disconnect();
			await new Promise((resolve) => setTimeout(resolve, 10));
			const ended = Object.fromEntries(sink.stream().filter((r) => r.event === 'upload.stream.ended').map((r) => [r.attributes.path, [r.attributes.outcome, r.attributes.code]]));
			expect(ended).toEqual({
				'slow/save': ['backpressure', 'FLOW_BACKPRESSURE'],
				'denied/save': ['rejected', 'FORBIDDEN'],
				'broken/save': ['handler-failed', 'INTERNAL_ERROR'],
				'files/save': ['disconnected', 'DISCONNECTED']
			});
			const count = (event) => sink.stream().filter((r) => r.event === event).length;
			expect([count('upload.stream.started'), count('upload.stream.ended')]).toEqual([4, 4]);
		} finally { sink.restore(); peer = undefined; }
	});

	it('answers and ends an upload whose middleware returns a failure without calling next()', async () => {
		const ctx = await setup();
		const sink = capture(ctx);
		try {
			let ran = false;
			ctx.live.middleware(async (mctx, next) => {
				if (mctx.upload) return { ok: false, code: 'FORBIDDEN', error: 'blocked here' };
				return next();
			});
			env.register('files', { save: ctx.live.upload(async () => { ran = true; return 1; }, { diagnostics: true }) });
			const handle = ctx.__upload('files/save')(new Uint8Array(100));
			await expect(handle).rejects.toMatchObject({ code: 'FORBIDDEN', message: 'blocked here' });
			expect(ran).toBe(false);
			expect(sink.stream().map((r) => [r.event, r.attributes.outcome, r.attributes.code])).toEqual([
				['upload.stream.started', undefined, undefined],
				['upload.stream.ended', 'rejected', 'FORBIDDEN']
			]);
		} finally { sink.restore(); }
	});

	it('fails an upload with INTERNAL_ERROR when middleware ends the chain without a failure', async () => {
		const ctx = await setup();
		const sink = capture(ctx);
		try {
			ctx.live.middleware(async () => {});
			env.register('files', { save: ctx.live.upload(async () => 1, { diagnostics: true }) });
			const handle = ctx.__upload('files/save')(new Uint8Array(100));
			await expect(handle).rejects.toMatchObject({ code: 'INTERNAL_ERROR' });
			const failed = sink.records.filter((r) => r.event === 'upload.execution.failed');
			expect(failed).toHaveLength(1);
			expect(failed[0].attributes.error).toMatch(/next\(\)/);
			expect(sink.stream().map((r) => [r.event, r.attributes.outcome, r.attributes.code])).toEqual([
				['upload.stream.started', undefined, undefined],
				['upload.stream.ended', 'rejected', 'INTERNAL_ERROR']
			]);
		} finally { sink.restore(); }
	});

	it('rejects a non-boolean diagnostics option', async () => {
		const ctx = await setup();
		expect(() => ctx.live.upload(async () => 1, { diagnostics: /** @type {any} */ (1) })).toThrow(/diagnostics/);
	});
});
