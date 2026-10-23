import { describe, expect, it, afterEach, vi } from 'vitest';
import { createTestEnv } from '../src/testing.js';
import { mockWs } from './helpers/mock-ws.js';
import { mockPlatform } from './helpers/mock-platform.js';
import { toArrayBuffer } from './helpers/encode.js';
import { realtime } from '../src/server.js';
import { installDeliveryAuthorization, beginDeliveryAdmission, endDeliveryAdmission, forgetDeliverySubscription } from '../src/server/delivery-authorization.js';

/** Record an admitted stream the way stream dispatch does. */
function rememberDeliverySubscription(ws, _platform, topic, rpc, args, module = { beginDeliveryAdmission, endDeliveryAdmission }) {
	const token = module.beginDeliveryAdmission(ws, topic, rpc, args);
	module.endDeliveryAdmission(ws, topic, rpc, args, true, token);
	return token !== undefined;
}

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
		expect(rememberDeliverySubscription(ws, {}, 'other', 'private/rpc', ['secret'], fresh)).toBe(false);
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

describe('delivery authorization configuration across realtime() calls', () => {
	/** A platform whose adapter policy the test can drive. */
	function adapterPlatform(connections = 0) {
		const platform = mockPlatform();
		platform.connections = connections;
		platform.installs = 0;
		platform.authorizeDelivery = (callback) => { platform.installs++; platform.gate = callback; };
		return platform;
	}
	const socket = () => ({ ...mockWs({ id: 'scanner' }), ended: null, end(code) { this.ended = code; } });

	it('switches to a realtime() call only when the adapter runs its hooks', async () => {
		vi.resetModules();
		const api = await import('../src/server.js');
		const seen = [];
		const warnings = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const hooks = api.realtime({ authorizeDelivery: () => { seen.push('first'); return true; }, authorizeWireSubscribe: false });
		const platform = adapterPlatform();
		hooks.init({ platform });
		const frame = { kind: 'message', topic: 'scans:e1', event: 'e', data: null, binary: false };
		// Another call that is never mounted changes nothing.
		const reloaded = api.realtime({ authorizeDelivery: () => { seen.push('second'); return false; }, authorizeWireSubscribe: false });
		api.realtime({ authorizeWireSubscribe: false });
		expect(platform.gate(socket(), frame)).toBe(true);
		expect(warnings).not.toHaveBeenCalled();
		// Running its hooks, as a reloaded hooks.ws does, switches without reinstalling.
		const ws = socket();
		reloaded.open(ws, { platform: Object.create(platform) });
		expect(ws.ended).toBeNull();
		expect(platform.installs).toBe(1);
		expect(platform.gate(socket(), frame)).toBe(false);
		expect(seen).toEqual(['first', 'second']);
		expect(warnings).toHaveBeenCalledTimes(1);
		expect(warnings).toHaveBeenCalledWith(expect.stringContaining('delivery-authorization.replaced'));
		// A retired call cannot reclaim: alternating hooks never switch back.
		const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
		const staleSockets = [];
		for (let i = 0; i < 10; i++) {
			const stale = socket();
			staleSockets.push(stale);
			hooks.message(stale, { platform: Object.create(platform), data: new ArrayBuffer(0) });
			const current = socket();
			reloaded.message(current, { platform: Object.create(platform), data: new ArrayBuffer(0) });
			expect(current.ended).toBeNull();
		}
		expect(staleSockets.every((stale) => stale.ended === 1011)).toBe(true);
		expect(platform.gate(socket(), frame)).toBe(false);
		expect(warnings).toHaveBeenCalledTimes(1);
		expect(errors.mock.calls.filter(([line]) => String(line).includes('delivery-authorization.stale'))).toHaveLength(1);
		expect(() => hooks.init({ platform })).toThrow('replaced by a newer delivery policy');
		errors.mockRestore();
		warnings.mockRestore();
	});

	it('treats realtime() calls with the same function and equal options as one policy', async () => {
		vi.resetModules();
		const api = await import('../src/server.js');
		const warnings = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const shared = () => true;
		const first = api.realtime({ authorizeDelivery: shared, deliveryAuthorizationOptions: { timeoutMs: 50 }, authorizeWireSubscribe: false });
		const second = api.realtime({ authorizeDelivery: shared, deliveryAuthorizationOptions: { timeoutMs: 50 }, authorizeWireSubscribe: false });
		const platform = adapterPlatform();
		first.init({ platform });
		for (let i = 0; i < 5; i++) {
			const a = socket(), b = socket();
			second.open(a, { platform: Object.create(platform) });
			first.open(b, { platform: Object.create(platform) });
			expect(a.ended).toBeNull();
			expect(b.ended).toBeNull();
		}
		expect(warnings).not.toHaveBeenCalled();
		warnings.mockRestore();
	});

	it('decides every stream reply of one frame with the policy active when the frame started', async () => {
		vi.resetModules();
		const api = await import('../src/server.js');
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		const seen = [];
		const platform = adapterPlatform();
		let next;
		const hooks = api.realtime({ authorizeDelivery: (_ctx, frame) => {
			seen.push('first:' + frame.topic);
			// A hook of a newer call runs while this frame is being decided.
			next.open(socket(), { platform: Object.create(platform) });
			return true;
		}, authorizeWireSubscribe: false });
		next = api.realtime({ authorizeDelivery: (_ctx, frame) => { seen.push('next:' + frame.topic); return true; }, authorizeWireSubscribe: false });
		hooks.init({ platform });
		platform.gate(socket(), { kind: 'message', topic: '__rpc', event: '__batch', binary: false, data: { batch: [{ ok: true, topic: 'a', data: 1 }, { ok: true, topic: 'b', data: 2 }] } });
		expect(seen).toEqual(['first:a', 'first:b']);
		platform.gate(socket(), { kind: 'message', topic: 'c', event: 'e', data: null, binary: false });
		expect(seen.at(-1)).toBe('next:c');
		vi.restoreAllMocks();
	});

	it('installs with the options of the call whose hooks ran first and refuses other options afterwards', async () => {
		vi.resetModules();
		const api = await import('../src/server.js');
		const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
		const warnings = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const early = api.realtime({ authorizeDelivery: () => true, deliveryAuthorizationOptions: { timeoutMs: 10 }, authorizeWireSubscribe: false });
		const mounted = api.realtime({ authorizeDelivery: () => true, deliveryAuthorizationOptions: { timeoutMs: 20 }, authorizeWireSubscribe: false });
		const platform = adapterPlatform();
		let installedOptions;
		platform.authorizeDelivery = (callback, options) => { platform.installs++; platform.gate = callback; installedOptions = options; };
		mounted.init({ platform });
		expect(installedOptions).toEqual({ timeoutMs: 20 });
		const ws = socket();
		early.open(ws, { platform: Object.create(platform) });
		expect(ws.ended).toBe(1011);
		expect(platform.installs).toBe(1);
		expect(() => early.init({ platform })).toThrow('different options');
		errors.mockRestore();
		warnings.mockRestore();
	});

	it('serves connections first seen after an init that installed while connections were open', async () => {
		vi.resetModules();
		const api = await import('../src/server.js');
		const hooks = api.realtime({ authorizeDelivery: () => true, authorizeWireSubscribe: false });
		const platform = adapterPlatform(2);
		hooks.init({ platform });
		const ws = socket();
		hooks.message(ws, { platform: Object.create(platform), data: new ArrayBuffer(0) });
		expect(ws.ended).toBeNull();
	});

	it('installs from close and unsubscribe hooks and serves the connection that was open before the install', async () => {
		vi.resetModules();
		const api = await import('../src/server.js');
		const hooks = api.realtime({ authorizeDelivery: () => true, authorizeWireSubscribe: false });
		const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
		const platform = adapterPlatform(1);
		const view = Object.create(platform);
		const stranger = socket();
		hooks.unsubscribe(stranger, 'scans:e1', { platform: view });
		expect(platform.installs).toBe(1);
		expect(stranger.ended).toBeNull();
		// Connections first seen after the install are covered.
		const late = socket();
		hooks.message(late, { platform: view, data: new ArrayBuffer(0) });
		expect(late.ended).toBeNull();
		const opened = socket();
		hooks.open(opened, { platform: view });
		hooks.message(opened, { platform: view, data: new ArrayBuffer(0) });
		expect(opened.ended).toBeNull();
		expect(platform.installs).toBe(1);
		expect(errors.mock.calls.filter(([line]) => String(line).includes('delivery-authorization.unguarded'))).toHaveLength(1);
		errors.mockRestore();
	});

	it('serves every connection when init installed the policy before any connection', async () => {
		vi.resetModules();
		const api = await import('../src/server.js');
		const hooks = api.realtime({ authorizeDelivery: () => true, authorizeWireSubscribe: false });
		const platform = adapterPlatform(0);
		hooks.init({ platform });
		platform.connections = 3;
		const ws = socket();
		hooks.message(ws, { platform: Object.create(platform), data: new ArrayBuffer(0) });
		expect(ws.ended).toBeNull();
		expect(platform.installs).toBe(1);
	});

	it('installs on the platform that owns authorizeDelivery, not on a view that inherits it', async () => {
		vi.resetModules();
		const api = await import('../src/server.js');
		const hooks = api.realtime({ authorizeDelivery: () => true, authorizeWireSubscribe: false });
		const platform = adapterPlatform(0);
		const middle = Object.create(platform);
		middle.publish = () => true;
		const view = Object.create(middle);
		const first = socket(), second = socket();
		hooks.open(first, { platform: view });
		hooks.open(second, { platform: Object.create(platform) });
		expect(platform.installs).toBe(1);
		expect(first.ended).toBeNull();
		expect(second.ended).toBeNull();
	});
});

describe('delivery authorization argument ownership', () => {
	it('keeps a __proto__ key in arguments as data and never as the prototype', () => {
		const seen = [];
		const { env, ws, gate } = setup((_ctx, frame) => { seen.push(frame); return true; });
		const args = JSON.parse('[{"__proto__": {"orgId": "victim"}, "eventId": "e1"}]');
		rememberDeliverySubscription(ws, env.platform, 'scans:e1', 'scan/log', args);
		gate({ topic: 'scans:e1', event: 'created', data: 1 });
		const [first] = seen[0].args;
		expect(Object.getPrototypeOf(first)).toBe(Object.prototype);
		expect(first.orgId).toBeUndefined();
		expect(Object.prototype.hasOwnProperty.call(first, '__proto__')).toBe(true);
		expect(first.eventId).toBe('e1');
	});

	it('passes class instances by reference without freezing the application object', () => {
		const seen = [];
		const { env, ws, gate } = setup((_ctx, frame) => { seen.push(frame); return true; });
		class Scope { #org = 'acme'; get org() { return this.#org; } }
		const scope = new Scope();
		rememberDeliverySubscription(ws, env.platform, 'scans:e1', 'scan/log', [scope]);
		gate({ topic: 'scans:e1', event: 'created', data: 1 });
		expect(seen[0].args[0]).toBe(scope);
		expect(seen[0].args[0].org).toBe('acme');
		expect(Object.isFrozen(scope)).toBe(false);
	});
});

describe('delivery authorization with concurrent admissions of one topic', () => {
	it('names the topic by the admitted stream when a concurrent admission is refused first', async () => {
		vi.resetModules();
		const api = await import('../src/server.js');
		const seen = [];
		const platform = mockPlatform();
		let gate;
		platform.authorizeDelivery = (callback) => { gate = callback; };
		const hooks = api.realtime({ authorizeDelivery: (_ctx, frame) => { seen.push(frame.rpc); return true; }, authorizeWireSubscribe: false });
		hooks.init({ platform });
		const ws = mockWs({ id: 'scanner' });
		api.__register('scan/denied', api.live.stream((_ctx, e) => 'scans:' + e, async () => []));
		api.__register('scan/log', api.live.stream((_ctx, e) => 'scans:' + e, async () => []));
		const subscribe = platform.subscribe;
		const pending = [];
		platform.subscribe = (socket, topic) => new Promise((resolve) => pending.push({ resolve, socket, topic }));
		api.handleRpc(ws, toArrayBuffer({ rpc: 'scan/denied', id: 'a', args: ['e1'], stream: true }), platform);
		api.handleRpc(ws, toArrayBuffer({ rpc: 'scan/log', id: 'b', args: ['e1'], stream: true }), platform);
		await vi.waitFor(() => expect(pending).toHaveLength(2));
		const [first, second] = pending;
		first.resolve('FORBIDDEN');
		await new Promise((resolve) => setTimeout(resolve, 20));
		second.resolve(subscribe(second.socket, second.topic));
		await vi.waitFor(() => expect(['a', 'b'].every((id) => platform.sent.some((row) => row.event === id))).toBe(true));
		const admitted = platform.sent.find((row) => row.event === 'a' || row.event === 'b' ? row.data.ok === true : false);
		expect(platform.sent.filter((row) => row.data?.ok === false && row.data.code === 'FORBIDDEN')).toHaveLength(1);
		gate(ws, { kind: 'message', topic: 'scans:e1', event: 'created', data: null, binary: false });
		expect(seen.at(-1)).toBe(admitted.event === 'a' ? 'scan/denied' : 'scan/log');
	});
});

describe('delivery authorization cost without a policy', () => {
	it('hands the adapter the plain hooks when no policy is configured', async () => {
		vi.resetModules();
		const api = await import('../src/server.js');
		const hooks = api.realtime({});
		expect(hooks.message).toBe(api.message);
		expect(hooks.unsubscribe).toBe(api.unsubscribe);
	});
});

describe('delivery authorization installation order and options', () => {
	function adapterPlatform() {
		const platform = mockPlatform();
		platform.connections = 0;
		platform.authorizeDelivery = (callback) => { platform.gate = callback; };
		return platform;
	}
	const socket = () => ({ ...mockWs({ id: 'scanner' }), ended: null, end(code) { this.ended = code; } });
	const frame = { kind: 'message', topic: 'scans:e1', event: 'e', data: null, binary: false };

	it('keeps the active policy when installing a newer one fails', async () => {
		vi.resetModules();
		const api = await import('../src/server.js');
		const warnings = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
		const first = api.realtime({ authorizeDelivery: () => true, authorizeWireSubscribe: false });
		const second = api.realtime({ authorizeDelivery: () => false, authorizeWireSubscribe: false });
		const platform = adapterPlatform();
		first.init({ platform });
		const broken = adapterPlatform();
		broken.authorizeDelivery = () => { throw new TypeError('refused'); };
		const ws = socket();
		second.open(ws, { platform: Object.create(broken) });
		expect(ws.ended).toBe(1011);
		expect(platform.gate(socket(), frame)).toBe(true);
		expect(warnings).not.toHaveBeenCalled();
		warnings.mockRestore();
		errors.mockRestore();
	});

	it('compares later calls with the options as installed, not as later mutated', async () => {
		vi.resetModules();
		const api = await import('../src/server.js');
		const options = { timeoutMs: 20 };
		const hooks = api.realtime({ authorizeDelivery: () => true, deliveryAuthorizationOptions: options, authorizeWireSubscribe: false });
		const platform = adapterPlatform();
		hooks.init({ platform });
		options.timeoutMs = 30;
		const same = api.realtime({ authorizeDelivery: () => true, deliveryAuthorizationOptions: { timeoutMs: 20 }, authorizeWireSubscribe: false });
		const ws = socket();
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		same.open(ws, { platform: Object.create(platform) });
		expect(ws.ended).toBeNull();
		vi.restoreAllMocks();
	});
});
