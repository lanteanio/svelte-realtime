import { describe, expect, it, afterEach, vi } from 'vitest';
import { createTestEnv } from '../src/testing.js';
import { mockWs } from './helpers/mock-ws.js';
import { mockPlatform } from './helpers/mock-platform.js';
import { toArrayBuffer } from './helpers/encode.js';
import { realtime } from '../src/server.js';
import { installDeliveryAuthorization, rememberDeliverySubscription, forgetDeliverySubscription } from '../src/server/delivery-authorization.js';

const environments = [];
afterEach(() => { for (const env of environments.splice(0)) env.cleanup(); });

/** Install the bridge on a test platform that records the adapter policy it receives. */
function setup(authorize, options) {
	const env = createTestEnv();
	environments.push(env);
	let gate, installedOptions;
	env.platform.authorizeDelivery = (callback, opts) => { gate = callback; installedOptions = opts; };
	installDeliveryAuthorization(env.platform, authorize, options);
	const ws = { getUserData: () => ({ id: 'scanner', sessionId: 'session-a' }) };
	return { env, ws, installedOptions, gate: frame => gate(ws, { binary: false, kind: 'message', event: null, data: undefined, ...frame }) };
}

describe('delivery authorization bridge', () => {
	it('fails startup when the adapter cannot enforce recipient authorization', () => {
		expect(() => installDeliveryAuthorization({}, () => true, undefined)).toThrow('has no platform.authorizeDelivery');
	});

	it('validates the realtime() options where they are written', () => {
		expect(() => realtime({ authorizeDelivery: 'yes' })).toThrow('realtime({ authorizeDelivery }): must be a function');
		expect(() => realtime({ deliveryAuthorizationOptions: { timeoutMs: 10 } })).toThrow('requires realtime({ authorizeDelivery })');
		expect(() => realtime({ authorizeDelivery: () => true, deliveryAuthorizationOptions: 5 })).toThrow('must be an object');
		expect(() => realtime({})).not.toThrow();
	});

	it('hands the options to the adapter unchanged for its own validation', () => {
		const options = { maxPendingBytes: 4096, timeoutMs: 250 };
		expect(setup(() => true, options).installedOptions).toBe(options);
	});

	it('passes raw subscription data and current connection identity to the policy', () => {
		const seen = [];
		const { gate } = setup((ctx, frame) => { seen.push([ctx.user.id, frame]); return true; });
		expect(gate({ topic: 'scanlog:org:event', event: 'row', data: 1 })).toBe(true);
		expect(seen).toEqual([['scanner', { kind: 'message', topic: 'scanlog:org:event', event: 'row', data: 1, binary: false, rpc: null, args: null }]]);
		expect(Object.isFrozen(seen[0][1])).toBe(true);
	});

	it('returns the policy answer unchanged, so synchronous answers stay inline and invalid ones stay distinguishable', async () => {
		const answers = [false, 'yes', undefined];
		for (const answer of answers) expect(setup(() => answer).gate({ topic: 't', event: 'e' })).toBe(answer);
		const pending = Promise.resolve(true);
		expect(setup(() => pending).gate({ topic: 't', event: 'e' })).toBe(pending);
		const failure = new Error('db down');
		expect(() => setup(() => { throw failure; }).gate({ topic: 't', event: 'e' })).toThrow(failure);
	});

	it('decides a request on its event and data without a topic', () => {
		const seen = [];
		const { env, ws, gate } = setup((_ctx, frame) => { seen.push(frame); return frame.event === 'confirm'; });
		rememberDeliverySubscription(ws, env.platform, 'scans:e1', 'scan/log', ['e1']);
		expect(gate({ kind: 'request', topic: null, event: 'confirm', data: { op: 'delete' } })).toBe(true);
		expect(gate({ kind: 'request', topic: null, event: 'other', data: null })).toBe(false);
		expect(seen[0]).toEqual({ kind: 'request', topic: null, event: 'confirm', data: { op: 'delete' }, binary: false, rpc: null, args: null });
	});

	it('attributes opaque derived output, initial snapshots and replay to admitted arguments', () => {
		const seen = [];
		const { env, ws, gate } = setup((_ctx, frame) => { seen.push(frame); return true; });
		const args = ['org', { event: 'e1' }];
		rememberDeliverySubscription(ws, env.platform, 'checkin/stats~opaque', 'checkin/stats', args);
		args[1].event = 'mutated';
		gate({ topic: 'checkin/stats~opaque', event: 'set', data: 2 });
		gate({ topic: '__rpc', event: 'id', data: { ok: true, topic: 'checkin/stats~opaque', data: 3 } });
		gate({ topic: '__rpc', event: 'id', data: { ok: true, topic: 'checkin/stats~opaque', data: [4], replay: true } });
		gate({ kind: 'replay', topic: 'checkin/stats~opaque', event: 'msg', data: 5 });
		expect(seen.map(frame => [frame.kind, frame.topic, frame.rpc, frame.args])).toEqual([
			['message', 'checkin/stats~opaque', 'checkin/stats', ['org', { event: 'e1' }]],
			['snapshot', 'checkin/stats~opaque', 'checkin/stats', ['org', { event: 'e1' }]],
			['replay', 'checkin/stats~opaque', 'checkin/stats', ['org', { event: 'e1' }]],
			['replay', 'checkin/stats~opaque', 'checkin/stats', ['org', { event: 'e1' }]]
		]);
		expect(Object.isFrozen(seen[0].args[1])).toBe(true);
		forgetDeliverySubscription(ws);
		gate({ topic: 'checkin/stats~opaque', event: 'set', data: 6 });
		expect(seen[4].rpc).toBeNull();
	});

	it('admits RPC, upload and protocol responses without asking the policy', () => {
		const seen = [];
		const { gate } = setup((_ctx, frame) => { seen.push(frame); return false; });
		expect(gate({ topic: '__rpc', event: 'id', data: { ok: true, data: 'ordinary' } })).toBe(true);
		expect(gate({ topic: '__rpc', event: 'id', data: { attach: true, topic: 'scans:e1' } })).toBe(true);
		expect(gate({ topic: '__rpc', event: '__topic_error', data: { topic: 'scans:e1', code: 'FORBIDDEN' } })).toBe(true);
		expect(gate({ topic: '__upload', event: '00000001', data: { ok: true, data: 'stored' } })).toBe(true);
		expect(gate({ topic: '__realtime', event: 'protocol-stale', data: {} })).toBe(true);
		expect(seen).toEqual([]);
		// A replay frame is never a response, whatever its topic.
		expect(gate({ kind: 'replay', topic: '__rpc', event: 'msg', data: {} })).toBe(false);
	});

	it('denies an RPC batch containing a revoked stream while permitting nonstream replies', () => {
		const { gate } = setup((_ctx, frame) => frame.topic !== 'revoked');
		expect(gate({ topic: '__rpc', data: { batch: [{ ok: true, data: 'ordinary' }, { ok: true, topic: 'revoked', data: 'secret' }] } })).toBe(false);
		expect(gate({ topic: '__rpc', data: { batch: [{ ok: true, data: 'ordinary' }, { ok: true, topic: 'allowed', data: 'fine' }] } })).toBe(true);
	});

	it('checks every stream in a batch in order across pending answers', async () => {
		const order = [];
		const { gate } = setup((_ctx, frame) => {
			order.push(frame.topic);
			return frame.topic === 'a' ? Promise.resolve(true) : frame.topic !== 'c';
		});
		const answer = gate({ topic: '__rpc', data: { batch: [{ ok: true, topic: 'a', data: 1 }, { ok: true, topic: 'b', data: 2 }, { ok: true, topic: 'c', data: 3 }, { ok: true, topic: 'd', data: 4 }] } });
		expect(typeof answer?.then).toBe('function');
		expect(await answer).toBe(false);
		expect(order).toEqual(['a', 'b', 'c']);
	});

	it('keeps no stream metadata while no policy is configured', async () => {
		vi.resetModules();
		const fresh = await import('../src/server/delivery-authorization.js');
		const ws = {};
		expect(fresh.rememberDeliverySubscription(ws, {}, 'other', 'private/rpc', ['secret'])).toBe(false);
		let gate;
		fresh.installDeliveryAuthorization({ authorizeDelivery: (callback) => { gate = callback; } }, (_ctx, frame) => frame, undefined);
		const seen = gate({ getUserData: () => ({}) }, { kind: 'message', topic: 'other', event: 'set', data: null, binary: false });
		expect(seen.rpc).toBeNull();
	});

	it('attributes topics admitted through a platform that does not inherit from the policy platform', () => {
		const seen = [];
		const { ws, gate } = setup((_ctx, frame) => { seen.push(frame); return true; });
		const busWrapped = { publish() {}, subscribe() {} };
		rememberDeliverySubscription(ws, busWrapped, 'scans:e1', 'scan/log', ['e1']);
		gate({ topic: 'scans:e1', event: 'created', data: 1 });
		expect(seen[0]).toMatchObject({ rpc: 'scan/log', args: ['e1'] });
	});

	it('keeps the attribution of a retired topic for frames still held, bounded per socket', () => {
		const seen = [];
		const { env, ws, gate } = setup((_ctx, frame) => { seen.push(frame); return true; });
		rememberDeliverySubscription(ws, env.platform, 'scans:e1', 'scan/log', ['e1']);
		forgetDeliverySubscription(ws, 'scans:e1');
		gate({ topic: 'scans:e1', event: 'created', data: 1 });
		expect(seen[0]).toMatchObject({ rpc: 'scan/log', args: ['e1'] });
		// Resubscribing records the new admission.
		rememberDeliverySubscription(ws, env.platform, 'scans:e1', 'scan/other', ['x']);
		gate({ topic: 'scans:e1', event: 'created', data: 2 });
		expect(seen[1].rpc).toBe('scan/other');
		for (let i = 0; i < 65; i++) {
			rememberDeliverySubscription(ws, env.platform, 'old:' + i, 'old/rpc', [i]);
			forgetDeliverySubscription(ws, 'old:' + i);
		}
		gate({ topic: 'old:0', event: 'e', data: null });
		gate({ topic: 'old:64', event: 'e', data: null });
		expect(seen.slice(2).map((frame) => frame.rpc)).toEqual([null, 'old/rpc']);
		forgetDeliverySubscription(ws);
		gate({ topic: 'old:64', event: 'e', data: null });
		expect(seen[4].rpc).toBeNull();
	});

	it('owns arguments that structured cloning rejects and keeps mutable values private per call', () => {
		const seen = [];
		const { env, ws, gate } = setup((_ctx, frame) => {
			if (seen.push(frame) === 1) {
				frame.args[1].set('k', 'tampered');
				frame.args[3][0] = 9;
			}
			return true;
		});
		const fn = () => 1;
		const sym = Symbol('id');
		const args = [{ fn, sym, nested: { n: 1 } }, new Map([['k', 'v']]), new Date(0), new Uint8Array([1, 2]), Buffer.from('ab')];
		expect(() => rememberDeliverySubscription(ws, env.platform, 'scans:e1', 'scan/log', args)).not.toThrow();
		args[0].nested.n = 2;
		args[1].set('k', 'mutated');
		gate({ topic: 'scans:e1', event: 'created', data: 1 });
		gate({ topic: 'scans:e1', event: 'created', data: 2 });
		const [first, second] = seen;
		expect(first.args[0]).toMatchObject({ fn, sym, nested: { n: 1 } });
		expect(second.args[1].get('k')).toBe('v');
		expect(second.args[3][0]).toBe(1);
		expect(second.args[2].getTime()).toBe(0);
		expect(Buffer.isBuffer(second.args[4]) && second.args[4].toString()).toBe('ab');
		expect(first.args).not.toBe(second.args);
		// Plain data is frozen once and shared.
		const plain = setup((_ctx, frame) => { seen.push(frame); return true; });
		rememberDeliverySubscription(plain.ws, plain.env.platform, 't', 'r', [{ a: [1] }]);
		plain.gate({ topic: 't', event: 'e' });
		plain.gate({ topic: 't', event: 'e' });
		expect(seen[2].args).toBe(seen[3].args);
		expect(Object.isFrozen(seen[2].args[0].a)).toBe(true);
	});
});

describe('delivery authorization in stream dispatch', () => {
	async function dispatchStream(api, platform, ws, path, id) {
		expect(api.handleRpc(ws, toArrayBuffer({ rpc: path, id, args: ['e1'], stream: true }), platform)).toBe(true);
		await vi.waitFor(() => expect(platform.sent.some((row) => row.topic === '__rpc' && row.event === id)).toBe(true));
	}

	it('attributes a topic before the adapter subscribe can deliver on it, and releases a refused admission', async () => {
		vi.resetModules();
		const api = await import('../src/server.js');
		const seen = [];
		const platform = mockPlatform();
		let gate;
		platform.authorizeDelivery = (callback) => { gate = callback; };
		const hooks = api.realtime({ authorizeDelivery: (_ctx, frame) => { seen.push(frame); return true; }, authorizeWireSubscribe: false });
		hooks.init({ platform });
		const ws = mockWs({ id: 'scanner' });
		api.__register('scan/denied', api.live.stream((_ctx, e) => 'scans:' + e, async () => []));
		api.__register('scan/log', api.live.stream((_ctx, e) => 'scans:' + e, async () => []));
		const subscribe = platform.subscribe;
		let refuse = true;
		platform.subscribe = async (socket, topic) => {
			// The adapter may deliver as soon as the membership exists.
			gate(socket, { kind: 'message', topic, event: 'created', data: null, binary: false });
			if (refuse) return 'FORBIDDEN';
			return subscribe(socket, topic);
		};
		await dispatchStream(api, platform, ws, 'scan/denied', 'one');
		refuse = false;
		await dispatchStream(api, platform, ws, 'scan/log', 'two');
		expect(seen.map((frame) => frame.rpc)).toEqual(['scan/denied', 'scan/log']);
	});
});
