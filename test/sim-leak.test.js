// Resource-leak churn harness for the realtime layer: drive clients through
// the real dispatch (dynamic-topic streams, a presence room, smoothed
// entities), sample the module-global registries once per churn cycle, and
// trend the series with the adapter's leak kernel. A close / unsubscribe /
// eviction path that stops shedding entries shows up as monotonic growth.
//
// The kernel (trend verdict, probe factory, assertion) is imported from the
// installed published adapter package rather than re-implemented: it is
// dependency-free and deterministic, so realtime's structural series feed it
// directly, and both repos share one definition of "what a leak looks like".
//
// Probe discipline (mirrors the kernel's exclusion list): only sizes that
// return to baseline as connections come and go are probed - never a
// monotonic-by-design counter. All probed maps live for the process, so the
// churn scenario uses DISTINCT topics and identities per cycle: an entry that
// fails to shed then accumulates across cycles instead of being reused.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
	createResourceTracker,
	structuralResourceProbes,
	assertNoResourceGrowth,
	LeakError
} from 'svelte-adapter-uws/sim';
import { runLiveSim } from '../src/sim.js';
import {
	live,
	__register,
	handleRpc,
	close,
	_setSmoothRuntime,
	_resetSmooth
} from '../src/server.js';
import {
	_topicWsCounts,
	_topicCoalesce,
	_topicTransform,
	_topicRedact,
	_topicVolatile,
	_topicStaleWatch,
	_silentTopicWatch,
	_presenceRef,
	_rateLimits
} from '../src/server/state.js';
import { _throttles, _debounces } from '../src/server/publish-helpers.js';
import { _smoothTopics } from '../src/server/smooth.js';
import { mockWs } from './helpers/mock-ws.js';
import { mockPlatform } from './helpers/mock-platform.js';

/**
 * Structural probes over the realtime layer's churn-sensitive module-global
 * registries. Every source either sheds entries on unsubscribe/close or (for
 * per-topic key maps) deletes the key when its last member leaves, so a
 * healthy run trends flat. Declaration-scoped registries (registry, guards,
 * cron/derived/effect/aggregate) are constant within a run and deliberately
 * not probed - they cannot churn, so their series carries no signal.
 */
function liveStructuralProbes() {
	return structuralResourceProbes({
		topicWsCounts: _topicWsCounts,
		// Total tracked sockets across all topics - catches a ws that is
		// removed from no set even while topic keys themselves shed.
		topicWsSockets: () => {
			let n = 0;
			for (const set of _topicWsCounts.values()) n += set.size;
			return n;
		},
		topicTransform: _topicTransform,
		topicRedact: _topicRedact,
		topicVolatile: _topicVolatile,
		topicCoalesce: _topicCoalesce,
		topicStaleWatch: _topicStaleWatch,
		silentTopicWatch: _silentTopicWatch,
		presenceRef: _presenceRef,
		rateLimits: _rateLimits,
		throttles: _throttles,
		debounces: _debounces
	});
}

describe('realtime resource-leak harness - stream + presence-room churn', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it('join/leave churn sheds every structural registry entry', async () => {
		const tracker = createResourceTracker(liveStructuralProbes());

		// Dynamic topics + a transform + volatile, so the refcounted per-topic
		// registries are entered and must be evicted; a presence room, so the
		// presence reference (and its leave grace timer) is exercised.
		const module = () => ({
			ticker: live.stream((ctx, ch) => 'ticker:' + ch, async () => [], {
				merge: 'crud',
				key: 'id',
				transform: (data) => data,
				volatile: true
			}),
			arena: live.room({
				topic: (ctx, id) => 'arena:' + id,
				topicArgs: 1,
				init: async () => [],
				presence: (ctx) => ({ name: ctx.user?.id || 'anon' })
			})
		});

		// Peak occupancy is read mid-cycle (the tracker samples only at cycle
		// end, when a healthy run is back at baseline): a zero peak would mean
		// the churn never touched the registry the probe watches.
		const peak = { sockets: 0, presence: 0, transform: 0, volatile: 0 };
		const scenario = async (api, opts) => {
			for (let cycle = 0; cycle < 12; cycle++) {
				// Fresh identities and fresh room/channel ids every cycle: a
				// retained entry can never be masked by key reuse.
				const conns = [];
				for (let i = 0; i < opts.clients; i++) {
					conns.push(api.connect({ id: 'user-' + cycle + '-' + i }));
				}
				const streams = [];
				for (const c of conns) {
					streams.push(c.subscribe('sim/ticker', 'ch' + cycle));
					streams.push(c.subscribe('sim/arena/__data', 'room' + cycle));
				}
				await api.flush();
				const topic = streams[0] && streams[0].topic;
				if (topic) api.publish(topic, 'created', { id: cycle });
				await api.flush();

				let sockets = 0;
				for (const set of _topicWsCounts.values()) sockets += set.size;
				peak.sockets = Math.max(peak.sockets, sockets);
				peak.presence = Math.max(peak.presence, _presenceRef.size);
				peak.transform = Math.max(peak.transform, _topicTransform.size);
				peak.volatile = Math.max(peak.volatile, _topicVolatile.size);

				for (const c of conns) c.disconnect();
				await api.flush();
				// The presence leave rides a grace timer; expire it so the cycle's
				// release actually runs before the sample.
				vi.advanceTimersByTime(5001);
				await api.flush();
				tracker.sample();
			}
		};

		const result = await runLiveSim({ seed: 'realtime-churn-clean', scenario, module, clients: 3 });
		expect(result.invariantViolations).toEqual([]);

		expect(() => assertNoResourceGrowth(tracker)).not.toThrow();

		// Non-vacuous: the churn actually populated the probed registries at
		// some point during the cycles (a dead probe trends flat trivially).
		expect(peak.sockets).toBeGreaterThan(0);
		expect(peak.presence).toBeGreaterThan(0);
		expect(peak.transform).toBeGreaterThan(0);
		expect(peak.volatile).toBeGreaterThan(0);
	});

	it('is non-vacuous: an app handler that retains a per-connection entry IS detected', async () => {
		// The leak: `join` records the connection but nothing ever releases it,
		// so the map grows by one per connection and never sheds.
		const leaked = new Map();
		const module = () => ({
			join: live(async (ctx) => {
				leaked.set(ctx.ws, true);
				return true;
			})
		});
		const tracker = createResourceTracker(structuralResourceProbes({ leaked }));

		const scenario = async (api, opts) => {
			for (let cycle = 0; cycle < 12; cycle++) {
				const conns = [];
				for (let i = 0; i < opts.clients; i++) {
					conns.push(api.connect({ id: 'leak-' + cycle + '-' + i }));
				}
				for (const c of conns) await c.call('sim/join');
				for (const c of conns) c.disconnect();
				await api.flush();
				tracker.sample();
			}
		};

		await runLiveSim({ seed: 'realtime-leak-planted', scenario, module, clients: 2 });

		expect(leaked.size).toBeGreaterThan(0);
		let caught;
		try {
			assertNoResourceGrowth(tracker);
		} catch (err) {
			caught = err;
		}
		expect(caught).toBeInstanceOf(LeakError);
		expect(caught.leaks.map((l) => l.name)).toContain('leaked');
	});

	it('control: the SAME churn with a correct release path does not leak', async () => {
		// Identical to the planted-leak case except `leave` releases the entry,
		// so the series oscillates around zero. Isolates the signal to the
		// missing cleanup, not the churn shape.
		const held = new Map();
		const module = () => ({
			join: live(async (ctx) => {
				held.set(ctx.ws, true);
				return true;
			}),
			leave: live(async (ctx) => {
				held.delete(ctx.ws);
				return true;
			})
		});
		const tracker = createResourceTracker(structuralResourceProbes({ held }));

		const scenario = async (api, opts) => {
			for (let cycle = 0; cycle < 12; cycle++) {
				const conns = [];
				for (let i = 0; i < opts.clients; i++) {
					conns.push(api.connect({ id: 'ctl-' + cycle + '-' + i }));
				}
				for (const c of conns) await c.call('sim/join');
				for (const c of conns) await c.call('sim/leave');
				for (const c of conns) c.disconnect();
				await api.flush();
				tracker.sample();
			}
		};

		await runLiveSim({ seed: 'realtime-leak-control', scenario, module, clients: 2 });

		expect(held.size).toBe(0);
		expect(() => assertNoResourceGrowth(tracker)).not.toThrow();
	});
});

// - Smoothed-entity registry churn ---------------------------------------------
// The smooth record map is keyed per wire topic and holds the per-connection
// registry, remote surrogates, and pending sync/wire queues. Churn subscribers
// through sync + close across distinct rooms and assert every record (and its
// nested bookkeeping) is reclaimed. The authority is scripted (the adapter's
// concern, exercised in its own repo); the record lifecycle under test is
// entirely realtime's.

const textEncoder = new TextEncoder();
const toArrayBuffer = (obj) => textEncoder.encode(JSON.stringify(obj)).buffer;
let _rpcId = 0;

async function rpc(ws, platform, path, args) {
	handleRpc(ws, toArrayBuffer({ rpc: path, id: 'lk' + ++_rpcId, args }), platform);
	await vi.advanceTimersByTimeAsync(1);
}

/** A minimal scripted smooth runtime: Map-backed authority + stub wire codec. */
function scriptedSmoothRuntime() {
	return {
		SMOOTH_TOPIC_PREFIX: '__smooth:',
		createSmoothAuthority() {
			const entities = new Map();
			return {
				ensure(key, ws, initial) {
					let e = entities.get(key);
					if (e === undefined) {
						e = { state: initial, ws, lastAckedId: 0 };
						entities.set(key, e);
					}
					return { state: e.state, lastAckedId: e.lastAckedId };
				},
				get(key) {
					return entities.get(key);
				},
				enqueue() {
					return true;
				},
				inject(key) {
					return entities.has(key);
				},
				drain() {
					return { updates: [], acks: [], events: [], idle: true };
				},
				remove(key) {
					return entities.delete(key);
				},
				removeWs(ws) {
					const removed = [];
					for (const [k, e] of entities) {
						if (e.ws === ws) {
							entities.delete(k);
							removed.push(k);
						}
					}
					return removed;
				},
				catalog() {
					return [...entities].map(([key, e]) => ({ key, state: e.state }));
				},
				get size() {
					return entities.size;
				}
			};
		},
		createSmoothWireCodec() {
			return {
				capability: 'smooth.protocol:1',
				schemaVersion: 1,
				encode: () => null,
				state: { onAttach: () => null, onDetach: () => {} }
			};
		}
	};
}

function wireMockPlatform() {
	const p = mockPlatform();
	p.publishWire = () => true;
	p.sendWire = () => 1;
	return p;
}

describe('realtime resource-leak harness - smooth record churn', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		_setSmoothRuntime(scriptedSmoothRuntime());
	});
	afterEach(() => {
		_resetSmooth();
		_setSmoothRuntime(null);
		vi.useRealTimers();
	});

	it('player churn on a LIVE record sheds its per-subscriber bookkeeping; the last close reclaims the record', async () => {
		// Interest mode, so the record carries real per-subscriber state (the
		// identity -> socket registry plus the relevancy tracker) - the
		// single-instance default keeps that bookkeeping empty, which would make
		// this probe vacuous.
		const shape = live.smooth({
			topic: (ctx, roomId) => 'shape:' + roomId,
			topicArgs: 1,
			apply: (state, cmd) => ({ x: state.x + (cmd.dx || 0), y: state.y + (cmd.dy || 0) }),
			initial: { x: 0, y: 0 },
			interest: { radius: 100, position: (s) => ({ x: s.x, y: s.y }) }
		});
		__register('lkm/shape/__smooth/sync', shape.__smoothSync, 'lkm');

		const tracker = createResourceTracker(
			structuralResourceProbes({
				smoothTopics: _smoothTopics,
				// Per-subscriber bookkeeping across all live records. The anchor
				// subscriber below keeps ONE record alive for the whole run, so a
				// churned player whose registry entry fails to shed accumulates
				// here instead of vanishing with a reclaimed record.
				smoothSubscriberEntries: () => {
					let n = 0;
					for (const rec of _smoothTopics.values()) {
						n += (rec.registry?.size || 0) + (rec.surrogates?.size || 0);
						n += (rec.pendingSync?.size || 0) + (rec.pendingWire?.size || 0);
					}
					return n;
				}
			})
		);

		const platform = wireMockPlatform();
		// The anchor holds the room open across every churn cycle.
		const anchor = mockWs({ id: 'anchor' });
		await rpc(anchor, platform, 'lkm/shape/__smooth/sync', ['arena']);
		expect(_smoothTopics.size).toBe(1);

		// Peak occupancy is read mid-cycle (the tracker samples only at cycle
		// end, when a healthy cycle is back at the anchor-only baseline).
		const peak = { entries: 0 };
		for (let cycle = 0; cycle < 12; cycle++) {
			const players = [
				mockWs({ id: 'p-' + cycle + '-a' }),
				mockWs({ id: 'p-' + cycle + '-b' })
			];
			for (const ws of players) {
				await rpc(ws, platform, 'lkm/shape/__smooth/sync', ['arena']);
			}
			let entries = 0;
			for (const rec of _smoothTopics.values()) entries += rec.registry?.size || 0;
			peak.entries = Math.max(peak.entries, entries);
			for (const ws of players) close(ws, { platform });
			await vi.advanceTimersByTimeAsync(60);
			tracker.sample();
		}

		expect(() => assertNoResourceGrowth(tracker)).not.toThrow();
		// Non-vacuous: churned players actually entered the live record's
		// registry alongside the anchor.
		expect(peak.entries).toBeGreaterThan(1);

		// The anchor's own close is the record's last local subscriber: the
		// record itself must now be reclaimed.
		close(anchor, { platform });
		await vi.advanceTimersByTimeAsync(60);
		expect(_smoothTopics.size).toBe(0);
	});
});
