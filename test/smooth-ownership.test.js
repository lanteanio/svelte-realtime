import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as runtime from 'svelte-adapter-uws/plugins/smooth';
import { live, handleRpc, close, __register, _setSmoothRuntime, _resetSmooth } from '../src/server.js';
import { _smoothTopics } from '../src/server/smooth.js';
import { setRuntimeEnv, resetRuntimeEnv } from '../src/shared/runtime.js';
import { mockPlatform } from './helpers/mock-platform.js';
import { mockWs } from './helpers/mock-ws.js';

let mono, timers, platform, ws, topic, handlers, grant, work, applied, seq = 0;
beforeEach(() => {
	mono = 0; timers = new Map(); work = 0; applied = 0;
	setRuntimeEnv({ clock: { monotonic: () => mono, wallEpoch: () => 100000 + mono }, timers: {
		set(fn, delay, ...args) { const token = {}; timers.set(token, { at: mono + delay, fn: () => fn(...args) }); return token; },
		clear(token) { timers.delete(token); }
	} });
	_setSmoothRuntime(runtime);
	platform = mockPlatform(); ws = mockWs({ id: 'player' }); topic = 'ownership-' + ++seq;
	grant = { epoch: '1', leaseMs: 100 };
	platform.smooth = {
		ownershipVersion: 1, instanceId: 'owner', onMessage(value) { handlers = value; },
		acquireOwner: vi.fn(async () => grant), renewOwner: vi.fn(async () => grant), releaseOwner: vi.fn(),
		relayBroadcast: vi.fn(), relayAck: vi.fn(), relayCommand: vi.fn(), sendSyncReply: vi.fn(),
		requestSync: vi.fn(), writeSnapshot: vi.fn(async () => {}), readSnapshot: vi.fn(async () => [])
	};
});
afterEach(() => { _resetSmooth(); _setSmoothRuntime(null); resetRuntimeEnv(); });
function declare(extra = {}) {
	const shape = live.smooth({ topic, tickMs: 20, initial: { x: 0, y: 0 },
		apply(state, command, ctx) { applied++; mono += work; ctx.emitEvent('move', {}); return { ...state, x: state.x + command.dx }; }, ...extra });
	__register(topic + '/sync', shape.__smoothSync, topic);
	__register(topic + '/command', shape.__smoothCommand, topic);
	__register(topic + '/shoot', shape.__smoothShoot, topic);
}
async function rpc(action, args = []) {
	const id = 'lease-' + ++seq;
	handleRpc(ws, new TextEncoder().encode(JSON.stringify({ rpc: topic + '/' + action, id, args })).buffer, platform);
	for (let i = 0; i < 100; i++) {
		const reply = platform.sent.find(message => message.event === id);
		if (reply) return reply.data;
		await new Promise(resolve => setImmediate(resolve));
	}
	throw Error('RPC did not settle');
}
function fire(at) {
	const [token, timer] = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
	timers.delete(token); mono = at ?? timer.at; timer.fn();
}
const frames = () => platform.published.filter(message => message.topic === '__smooth:' + topic);
const settle = () => new Promise(resolve => setImmediate(resolve));
async function answerSync(pending, epoch = '2') {
	for (let i = 0; i < 100 && !platform.smooth.requestSync.mock.calls.length; i++) await settle();
	expect(platform.smooth.requestSync).toHaveBeenCalled();
	const [wire, , , corr] = platform.smooth.requestSync.mock.calls.at(-1);
	handlers.onSyncReply(wire, corr, { ack: 0, states: [] }, epoch);
	return pending;
}

it('fences a stalled owner before draining queued commands or accepting relays', async () => {
	declare(); expect((await rpc('sync')).ok).toBe(true);
	await rpc('command', [[{ id: 1, cmd: { dx: 2 } }]]);
	mono = 101;
	handlers.onCommand('__smooth:' + topic, 'remote', 'edge', [{ id: 1, cmd: { dx: 5 } }]);
	handlers.onSync('__smooth:' + topic, 'remote', 'edge', 'sync');
	fire(101);
	expect(applied).toBe(0);
	expect(platform.smooth.sendSyncReply).not.toHaveBeenCalled();
	expect(frames()).toEqual([]);
	expect(platform.smooth.relayBroadcast).not.toHaveBeenCalled();
});

it('checks the lease again after application work and before local updates, acks, and events', async () => {
	declare({ snapshot: true }); await rpc('sync'); await rpc('command', [[{ id: 1, cmd: { dx: 2 } }]]);
	work = 101; fire();
	expect(applied).toBe(1);
	expect(frames()).toEqual([]);
	expect(platform.sent.filter(message => message.event === 'ack')).toEqual([]);
	expect(platform.smooth.relayBroadcast).not.toHaveBeenCalled();
	expect(platform.smooth.writeSnapshot).not.toHaveBeenCalled();
});

it.each([false, true])('never reopens an older epoch when owner identities alternate (cells=%s)', async cells => {
	grant = null;
	declare(cells ? { interest: { radius: 100, cell: 100, cells: true, position: state => state } } : {});
	const sync = rpc('sync');
	while (!platform.smooth.requestSync.mock.calls.length) await new Promise(resolve => setImmediate(resolve));
	const [wire, , , corr] = platform.smooth.requestSync.mock.calls[0];
	handlers.onSyncReply(wire, corr, { ack: 0, states: [] }, '9'); await sync;
	const channel = cells ? '__smoothcell:' + topic + '#0,0' : wire;
	handlers.onBroadcast(channel, 'update', { key: 'other', data: { x: 10, y: 0 } }, undefined, 0, 'new', '10');
	handlers.onBroadcast(wire, 'event', { type: 'stale', key: 'other', data: {}, id: 1 }, undefined, 200, 'old', '9');
	handlers.onBroadcast(channel, 'update', { key: 'other', data: { x: 11, y: 0 } }, undefined, 1, 'new', '10');
	handlers.onBroadcast(channel, 'update', { key: 'other', data: { x: 2, y: 0 } }, undefined, 201, 'old', '9');
	expect(platform.published.filter(message => message.event === 'update').map(message => message.data.data.x)).toEqual([10, 11]);
	expect(platform.published.filter(message => message.event === 'event')).toEqual([]);
});

it.each([
	['an unknown ownership version', (smooth) => { smooth.ownershipVersion = 2; }],
	['a missing lease method', (smooth) => { delete smooth.releaseOwner; }],
	['a pre-v1 coordinator without lease methods', (smooth) => { delete smooth.ownershipVersion; delete smooth.renewOwner; }]
])('fails closed on %s', async (_name, change) => {
	change(platform.smooth); declare();
	const result = await rpc('sync');
	expect(result.ok).toBe(false);
	expect(platform.smooth.acquireOwner).not.toHaveBeenCalled();
});

describe('a coordinator without ownershipVersion', () => {
	let owner, renew, warn;
	beforeEach(() => {
		owner = true; renew = async () => true;
		warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		delete platform.smooth.ownershipVersion;
		platform.smooth.acquireOwner = vi.fn(async () => owner);
		platform.smooth.renewOwner = vi.fn(async () => renew());
	});
	const wire = () => '__smooth:' + topic;
	const updates = () => platform.published.filter(message => message.topic === wire() && message.event === 'update').map(message => message.data.data.x);

	it('runs on the pre-v1 boolean path with one warning per coordinator', async () => {
		declare(); expect((await rpc('sync')).ok).toBe(true);
		expect((await rpc('sync')).ok).toBe(true);
		const rec = _smoothTopics.get(topic);
		expect(rec.owned).toBe(true);
		expect(platform.smooth.acquireOwner).toHaveBeenCalledWith(wire());
		expect(warn.mock.calls.filter(([message]) => String(message).includes('pre-v1 boolean ownership path'))).toHaveLength(1);
		await rpc('command', [[{ id: 1, cmd: { dx: 2 } }]]); fire();
		expect(applied).toBe(1);
		expect(platform.smooth.relayBroadcast).toHaveBeenCalled();
	});

	it('keeps the tenure while renewals answer true or throw, and ends it when one answers false', async () => {
		declare(); await rpc('sync');
		const rec = _smoothTopics.get(topic);
		renew = async () => { throw Error('redis blip'); };
		fire(); await settle(); await settle();
		expect(platform.smooth.renewOwner).toHaveBeenCalledWith(wire());
		expect(rec.owned).toBe(true);
		const epoch = rec.ownerEpoch;
		renew = async () => true;
		mono += 3000; fire(mono); await settle(); await settle();
		expect(rec.owned).toBe(true);
		expect(rec.ownerEpoch).toBe(epoch);
		renew = async () => false;
		mono += 3000; fire(mono); await settle(); await settle();
		expect(rec.owned).toBe(false);
	});

	it('starts a new epoch and authority for a new tenure', async () => {
		declare(); await rpc('sync'); await rpc('command', [[{ id: 1, cmd: { dx: 2 } }]]); fire();
		const rec = _smoothTopics.get(topic);
		const first = rec.ownerEpoch;
		renew = async () => false;
		mono += 3000; fire(mono); await settle(); await settle();
		expect(rec.owned).toBe(false);
		expect((await rpc('sync')).ok).toBe(true);
		expect(rec.owned).toBe(true);
		expect(BigInt(rec.ownerEpoch)).toBeGreaterThan(BigInt(first));
		expect(rec.authority.get('player').state).toEqual({ x: 0, y: 0 });
	});

	it('keeps a working local authority when acquisition rejects, as the pre-v1 path does', async () => {
		platform.smooth.acquireOwner = vi.fn(async () => { throw Error('offline'); });
		declare(); expect((await rpc('sync')).ok).toBe(true);
		expect(_smoothTopics.get(topic).owned).toBe(true);
		await rpc('command', [[{ id: 1, cmd: { dx: 1 } }]]); fire();
		expect(applied).toBe(1);
	});

	it('delivers relays without an epoch and deduplicates them per owner instance', async () => {
		owner = false;
		declare(); await answerSync(rpc('sync'), undefined);
		const rec = _smoothTopics.get(topic);
		expect(rec.owned).toBe(false);
		handlers.onBroadcast(wire(), 'update', { key: 'other', data: { x: 1, y: 0 } }, undefined, 0, 'first');
		handlers.onBroadcast(wire(), 'update', { key: 'other', data: { x: 9, y: 0 } }, undefined, 0, 'first');
		handlers.onBroadcast(wire(), 'update', { key: 'other', data: { x: 2, y: 0 } }, undefined, 1, 'first');
		// A new owner starts its own sequence.
		handlers.onBroadcast(wire(), 'update', { key: 'other', data: { x: 3, y: 0 } }, undefined, 0, 'second');
		handlers.onBroadcast(wire(), 'update', { key: 'other', data: { x: 8, y: 0 } }, undefined, 0, 'second');
		expect(updates()).toEqual([1, 2, 3]);
		handlers.onAck(wire(), 'player', { id: 4, state: { x: 4, y: 0 } });
		expect(platform.sent.filter(message => message.event === 'ack').map(message => message.data.id)).toEqual([4]);
	});

	it('completes a non-owner sync from a reply without an epoch', async () => {
		owner = false;
		declare();
		const result = await answerSync(rpc('sync'), undefined);
		expect(result.ok).toBe(true);
		expect(platform.smooth.requestSync).toHaveBeenCalledOnce();
	});
});

it('does not promote an acquisition whose lease elapsed while awaiting its reply', async () => {
	platform.smooth.acquireOwner = async () => { mono = 101; return grant; };
	declare(); const pending = rpc('sync');
	await answerSync(pending);
	expect(_smoothTopics.get(topic).owned).toBe(false);
	expect(_smoothTopics.get(topic).authority.size).toBe(0);
});

it('does not revive an expired lease from a late successful renewal', async () => {
	let resolve;
	platform.smooth.renewOwner = () => new Promise(done => { resolve = done; });
	declare(); await rpc('sync'); fire(); await settle();
	const rec = _smoothTopics.get(topic);
	mono = 101; resolve({ epoch: '1', leaseMs: 10000 }); await settle();
	expect(rec.owned).toBe(false);
	expect(rec.ownerDeadline).toBe(0);
});

it.each([null, { epoch: '1', leaseMs: 10000 }])('ignores old renewal completion after a newer acquisition (%j)', async result => {
	let resolve;
	platform.smooth.renewOwner = () => new Promise(done => { resolve = done; });
	declare(); await rpc('sync'); fire(); await settle();
	const rec = _smoothTopics.get(topic);
	handlers.onBroadcast('__smooth:' + topic, 'event', { type: 'handoff' }, undefined, 0, 'other', '2');
	grant = { epoch: '3', leaseMs: 10000 };
	expect((await rpc('sync')).ok).toBe(true);
	resolve(result); await settle();
	expect(rec.owned).toBe(true);
	expect(rec.ownerEpoch).toBe('3');
});

it('discards an obsolete snapshot completion after a newer owner frame', async () => {
	let resolve;
	platform.smooth.readSnapshot = () => new Promise(done => { resolve = done; });
	declare({ snapshot: true }); const pending = rpc('sync');
	while (!resolve) await settle();
	handlers.onBroadcast('__smooth:' + topic, 'event', { type: 'handoff' }, undefined, 0, 'other', '2');
	resolve([{ key: 'player', state: { x: 999, y: 0 } }]);
	await answerSync(pending);
	const rec = _smoothTopics.get(topic);
	expect(rec.owned).toBe(false);
	expect(rec.pendingSnapshot).toBe(null);
	expect(rec.authority.size).toBe(0);
});

it.each([false, true])('fences state packing that outlives the lease (cells=%s)', async cells => {
	let slow = false;
	declare({ wire: { state: { pack(state) { if (slow) mono += 101; return state; }, unpack: state => state } },
		...(cells && { interest: { radius: 100, cells: true, position: state => state } }) });
	await rpc('sync'); await rpc('command', [[{ id: 1, cmd: { dx: 2 } }]]);
	slow = true; fire();
	expect(platform.published).toEqual([]);
	expect(platform.sent.filter(message => message.event === 'ack')).toEqual([]);
});

it('drops old acks and compares epochs without floating point rounding', async () => {
	grant = null; declare(); await answerSync(rpc('sync'), '9007199254740992');
	const wire = '__smooth:' + topic;
	handlers.onAck(wire, 'player', { id: 2, state: { x: 2 } }, '9007199254740993');
	handlers.onAck(wire, 'player', { id: 1, state: { x: 1 } }, '9007199254740992');
	handlers.onAck(wire, 'player', { id: 3, state: { x: 3 } }, '09007199254740994');
	expect(platform.sent.filter(message => message.event === 'ack').map(message => message.data.id)).toEqual([2]);
});

it('does not run a local authority when acquisition rejects', async () => {
	platform.smooth.acquireOwner = async () => { throw Error('offline'); };
	declare(); await answerSync(rpc('sync'));
	expect(_smoothTopics.get(topic).owned).toBe(false);
	await rpc('command', [[{ id: 1, cmd: { dx: 1 } }]]);
	expect(applied).toBe(0);
	expect(platform.smooth.relayCommand).toHaveBeenCalledOnce();
});

it('forwards a local command and suppresses departure broadcasts after expiry', async () => {
	declare(); await rpc('sync');
	mono = 101;
	await rpc('command', [[{ id: 1, cmd: { dx: 1 } }]]);
	expect(platform.smooth.relayCommand).toHaveBeenCalledOnce();
	expect(_smoothTopics.get(topic).authority.get('player').queue).toEqual([]);
	close(ws, { platform });
	expect(frames()).toEqual([]);
	expect(platform.smooth.relayBroadcast).not.toHaveBeenCalled();
});

it('contains a failed asynchronous lease release while reclaiming the closed topic', async () => {
	declare(); await rpc('sync');
	platform.smooth.releaseOwner = async () => { throw Error('offline'); };
	close(ws, { platform }); await settle();
	expect(_smoothTopics.has(topic)).toBe(false);
});

it('stamps acknowledgements, snapshots, and releases with the current epoch', async () => {
	grant = { epoch: '9007199254740993', leaseMs: 10000 }; declare({ snapshot: true }); await rpc('sync');
	const wire = '__smooth:' + topic;
	handlers.onSync(wire, 'remote', 'edge', 'join');
	handlers.onCommand(wire, 'remote', 'edge', [{ id: 1, cmd: { dx: 2 } }]);
	fire(); await settle();
	expect(platform.smooth.sendSyncReply.mock.calls[0].at(-1)).toBe(grant.epoch);
	expect(platform.smooth.relayAck.mock.calls[0].at(-1)).toBe(grant.epoch);
	expect(platform.smooth.relayBroadcast.mock.calls.every(call => call.at(-1) === grant.epoch)).toBe(true);
	expect(platform.smooth.writeSnapshot.mock.calls[0].at(-1)).toBe(grant.epoch);
	platform.clockFence = { fenced: () => true };
	await rpc('command', [[{ id: 1, cmd: { dx: 1 } }]]);
	expect(platform.smooth.releaseOwner).toHaveBeenCalledWith(wire, grant.epoch);
});

it('rejects a sync reply superseded before its awaiting continuation runs', async () => {
	grant = null; declare({ interest: { radius: 100, position: state => state } });
	const pending = rpc('sync');
	while (!platform.smooth.requestSync.mock.calls.length) await settle();
	const [wire, , , corr] = platform.smooth.requestSync.mock.calls[0];
	handlers.onSyncReply(wire, corr, { ack: 99, states: [{ key: 'other', state: { x: 999, y: 0 } }] }, '1');
	handlers.onBroadcast(wire, 'event', { type: 'handoff' }, undefined, 0, 'next', '2');
	expect((await pending).ok).toBe(false);
	expect(_smoothTopics.get(topic)?.shadow.has('other') ?? false).toBe(false);
});

it('releases a new cell subscriber when position work consumes the sync lease', async () => {
	let positions = 0;
	declare({ interest: { radius: 100, cells: true, position(state) { if (++positions === 2) mono = 101; return state; } } });
	expect((await rpc('sync')).ok).toBe(false);
	expect(positions).toBe(2);
	expect(_smoothTopics.get(topic)?.registry.has('player') ?? false).toBe(false);
	expect(ws.getTopics()).toEqual([]);
});

it('does not roll a newer cell placement back when an older resync loses its basis', async () => {
	grant = null;
	let positions = 0, armed = false;
	declare({ interest: { radius: 100, cell: 100, cells: true, position(state) {
		if (armed && ++positions === 2) handlers.onAck('__smooth:' + topic, 'player', { id: 2, state: { x: 2000, y: 0 }, t: 100000 }, '2');
		return state;
	} } });
	await answerSync(rpc('sync'), '1');
	handlers.onAck('__smooth:' + topic, 'player', { id: 1, state: { x: 0, y: 0 }, t: 100000 }, '1');
	armed = true;
	const pending = rpc('sync');
	while (platform.smooth.requestSync.mock.calls.length < 2) await settle();
	const [wire, , , corr] = platform.smooth.requestSync.mock.calls[1];
	handlers.onSyncReply(wire, corr, { ack: 1, states: [{ key: 'player', state: { x: 0, y: 0 } }] }, '1');
	expect((await pending).ok).toBe(false);
	expect(_smoothTopics.get(topic).cells.lastPos.get('player')).toEqual({ x: 2000, y: 0 });
	expect(ws.getTopics().some(value => value.endsWith('#20,0'))).toBe(true);
});

it.each(['single', 'parallel', 'sequential'])('checks a sync basis at actual RPC emission (%s)', async mode => {
	let queued = false;
	declare({ wire: { state: { pack(state) {
		if (!queued) { queued = true; queueMicrotask(() => {
			mono = 101;
			handlers.onBroadcast('__smooth:' + topic, 'event', { type: 'handoff' }, undefined, 0, 'next', '2');
		}); }
		return state;
	}, unpack: state => state } } });
	if (mode === 'single') {
		const result = await rpc('sync');
		expect(result.ok).toBe(false);
		expect(result.code).toBe('UNAVAILABLE');
		return;
	}
	handleRpc(ws, new TextEncoder().encode(JSON.stringify({
		batch: [{ rpc: topic + '/sync', id: 'sync-result', args: [] }], sequential: mode === 'sequential'
	})).buffer, platform);
	for (let i = 0; i < 100 && !platform.sent.some(message => message.event === '__batch'); i++) await settle();
	const result = platform.sent.find(message => message.event === '__batch').data.batch[0];
	expect(result.ok).toBe(false);
	expect(result.code).toBe('UNAVAILABLE');
	expect(result.data).toBeUndefined();
});

it.each(['pack', 'position'].flatMap(callback => ['ack', 'update'].map(event => ({ callback, event }))))(
	'keeps cell placement on the latest epoch when $callback reenters $event delivery', async ({ callback, event }) => {
		grant = null;
		let armed = false, injected = false;
		const deliver = (epoch, x) => event === 'ack'
			? handlers.onAck('__smooth:' + topic, 'player', { id: Number(epoch), state: { x, y: 0 }, t: 100000 }, epoch)
			: handlers.onBroadcast('__smoothcell:' + topic + '#' + x / 100 + ',0', 'update', { key: 'player', data: { x, y: 0 } }, undefined, 0, 'owner-' + epoch, epoch);
		const reenter = () => { if (armed && !injected) { injected = true; deliver('2', 2000); } };
		declare({ interest: { radius: 100, cell: 100, cells: true, position(state) { if (callback === 'position') reenter(); return state; } },
			wire: { state: { pack(state) { if (callback === 'pack') reenter(); return state; }, unpack: state => state } } });
		await answerSync(rpc('sync'), '1');
		armed = true; deliver('1', 0);
		expect(injected).toBe(true);
		expect(_smoothTopics.get(topic).lastSeenEpoch).toBe('2');
		expect(_smoothTopics.get(topic).cells.lastPos.get('player')).toEqual({ x: 2000, y: 0 });
		expect(ws.getTopics().some(value => value.endsWith('#20,0'))).toBe(true);
		expect(ws.getTopics().some(value => value.endsWith('#0,0'))).toBe(false);
	}
);

it.each(['pack', 'position'])('preserves newer interest updates that arrive during %s callbacks', async callback => {
	grant = null;
	let armed = false, injected = false;
	const reenter = () => {
		if (!armed || injected) return;
		injected = true;
		handlers.onBroadcast('__smooth:' + topic, 'update', { key: 'other', data: { x: 2, y: 0 } }, undefined, 0, 'new', '2');
	};
	declare({ interest: { radius: 100, position(state) { if (callback === 'position') reenter(); return state; } },
		wire: { state: { pack(state) { if (callback === 'pack') reenter(); return state; }, unpack: state => state } } });
	await answerSync(rpc('sync'), '1');
	armed = true;
	handlers.onBroadcast('__smooth:' + topic, 'update', { key: 'other', data: { x: 1, y: 0 } }, undefined, 0, 'old', '1');
	for (let i = 0; i < 5 && timers.size; i++) fire();
	expect(injected).toBe(true);
	expect(platform.sent.filter(message => message.event === 'update').map(message => message.data.data.x)).toEqual([2]);
});

it('prevents an asynchronous hit from injecting into or emitting from a replacement tenure', async () => {
	let resume, injectResult;
	declare({
		initial: key => ({ x: key === 'player' ? 0 : 50, y: 0 }),
		interest: { radius: 100, position: state => state },
		hitTest: {
			hitbox: { shape: 'circle', radius: 5 },
			shot: { type: 'ray', origin: (_cmd, state) => state, dir: () => 0, maxDist: 100 },
			async onHit(ctx, target) {
				await new Promise(done => { resume = done; });
				injectResult = ctx.applyTo(target.key, { dx: 999 });
				ctx.emitEvent('old-hit', {});
			}
		}
	});
	await rpc('sync');
	handlers.onSync('__smooth:' + topic, 'victim', 'edge', 'join');
	fire(); await settle();
	const pending = rpc('shoot', [{ cmd: {}, rt: 100020 }]);
	for (let i = 0; i < 100 && !resume; i++) await settle();
	expect(resume).toBeTypeOf('function');
	handlers.onBroadcast('__smooth:' + topic, 'event', { type: 'handoff' }, undefined, 0, 'other', '2');
	grant = { epoch: '3', leaseMs: 10000 }; await rpc('sync');
	handlers.onSync('__smooth:' + topic, 'victim', 'edge', 'rejoin');
	resume(); await pending;
	expect(injectResult).toBe(false);
	expect(_smoothTopics.get(topic).authority.get('victim').queue).toEqual([]);
	expect(frames().some(frame => frame.data.type === 'old-hit')).toBe(false);
});

it('revokes custom projectile capabilities across an awaiting ownership change', async () => {
	let resume, accepted;
	declare({ interest: { radius: 100, position: state => state }, hitTest: {
		async resolveShot(ctx) {
			await new Promise(done => { resume = done; });
			accepted = ctx.applyTo(ctx.identity, { dx: 999 });
			ctx.emitEvent('old-projectile', {});
		}
	} });
	await rpc('sync');
	const pending = rpc('shoot', [{ cmd: {}, rt: 100000 }]);
	for (let count = 0; count < 100 && !resume; count++) await settle();
	expect(resume).toBeTypeOf('function');
	handlers.onBroadcast('__smooth:' + topic, 'event', { type: 'handoff' }, undefined, 0, 'other', '2');
	grant = { epoch: '3', leaseMs: 10000 };
	await rpc('sync');
	resume();
	await pending;
	expect(accepted).toBe(false);
	expect(_smoothTopics.get(topic).authority.get('player').queue).toEqual([]);
	expect(frames().some(frame => frame.data.type === 'old-projectile')).toBe(false);
});
