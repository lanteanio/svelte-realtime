// Lag-compensated action evaluation: the room history ring (recorded after
// each successful action) and ctx.compensate() (clamped client-stamped
// rewind, queued publishes, fail-safe fallback). Time is scripted through
// vitest fake timers - the ring reads the exact wall clock, which follows
// the mocked Date - so every rewind window in here is deterministic.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { live, handleRpc, __register, LiveError } from '../src/server.js';
import { mockWs } from './helpers/mock-ws.js';
import { mockPlatform } from './helpers/mock-platform.js';

const textEncoder = new TextEncoder();
const toArrayBuffer = (obj) => textEncoder.encode(JSON.stringify(obj)).buffer;

let _id = 0;

/** Register a room export's actions under a unique module path. */
function registerRoomActions(moduleName, room) {
	for (const [k, v] of Object.entries(room.__actions)) {
		__register(moduleName + '/room/__action/' + k, v, moduleName);
	}
}

/** Invoke a registered action and return the RPC response payload. */
async function callAction(ws, platform, path, args) {
	const before = platform.sent.length;
	handleRpc(ws, toArrayBuffer({ rpc: path, id: 'c' + ++_id, args }), platform);
	await vi.advanceTimersByTimeAsync(1);
	return platform.sent[before]?.data;
}

describe('live.room history config validation', () => {
	it('rejects history without a capture function', () => {
		expect(() => live.room({
			topic: (ctx, id) => 'h:' + id,
			init: async () => [],
			topicArgs: 1,
			actions: { noop: async () => 'ok' },
			history: {}
		})).toThrow('capture');
	});

	it('rejects history on a room without actions', () => {
		expect(() => live.room({
			topic: (ctx, id) => 'h:' + id,
			init: async () => [],
			history: { capture: () => ({}) }
		})).toThrow('requires actions');
	});

	it('rejects out-of-range bounds', () => {
		const base = {
			topic: (ctx, id) => 'h:' + id,
			init: async () => [],
			topicArgs: 1,
			actions: { noop: async () => 'ok' }
		};
		expect(() => live.room({ ...base, history: { capture: () => ({}), maxEntries: 0 } })).toThrow('maxEntries');
		expect(() => live.room({ ...base, history: { capture: () => ({}), maxAgeMs: -5 } })).toThrow('maxAgeMs');
		expect(() => live.room({ ...base, history: { capture: () => ({}), maxTopics: 1.5 } })).toThrow('maxTopics');
	});
});

describe('ctx.compensate outside a history room', () => {
	it('responds with a VALIDATION error and guidance', async () => {
		const room = live.room({
			topic: (ctx, id) => 'nohist:' + id,
			init: async () => [],
			topicArgs: 1,
			actions: {
				shoot: async (ctx, id) => ctx.compensate(123, () => 'never')
			}
		});
		registerRoomActions('nohist', room);

		vi.useFakeTimers();
		try {
			const res = await callAction(mockWs({ id: 'u1' }), mockPlatform(), 'nohist/room/__action/shoot', ['r1']);
			expect(res.ok).toBe(false);
			expect(res.code).toBe('VALIDATION');
			expect(res.error).toContain('history');
		} finally {
			vi.useRealTimers();
		}
	});
});

describe('history ring + ctx.compensate', () => {
	/** Mutable app-owned world the capture closure snapshots. */
	let world;
	let ws;
	let platform;

	/** Build and register a fresh history room; returns the action paths. */
	function makeRoom(moduleName, historyExtras = {}, capture = () => ({ ...world })) {
		const room = live.room({
			topic: (ctx, roomId) => moduleName + ':' + roomId,
			init: async () => [],
			topicArgs: 1,
			history: { capture, ...historyExtras },
			actions: {
				move: async (ctx, roomId, x) => {
					world.x = x;
					return x;
				},
				shoot: async (ctx, roomId, firedAt, options) =>
					ctx.compensate(firedAt, (state, meta) => ({ state, meta }), options),
				fire: async (ctx, roomId, firedAt) =>
					ctx.compensate(firedAt, (state) => {
						ctx.publish('boom', { at: state.x });
						return 'fired';
					}),
				misfire: async (ctx, roomId, firedAt) =>
					ctx.compensate(firedAt, (state) => {
						ctx.publish('boom', { at: state.x });
						throw new Error('jam');
					}),
				mutate: async (ctx, roomId, firedAt) =>
					ctx.compensate(firedAt, (state) => {
						state.x = 999;
						return state.x;
					}),
				nested: async (ctx, roomId, firedAt) =>
					ctx.compensate(firedAt, async (outerState, outerMeta) => {
						// Two sequential nested calls: the second must still be
						// detected (the flag is restored, not cleared).
						const first = await ctx.compensate(firedAt, (s, m) => m);
						const second = await ctx.compensate(firedAt, (s, m) => m);
						return { outerMeta, first, second };
					}),
				both: async (ctx, roomId, firedAtA, firedAtB) => {
					const [a, b] = await Promise.all([
						ctx.compensate(firedAtA, (state, meta) => ({ state, meta })),
						ctx.compensate(firedAtB, (state, meta) => ({ state, meta }))
					]);
					// A sequential compensate AFTER the concurrent pair must
					// rewind again - the in-flight guard must fully unwind.
					const c = await ctx.compensate(firedAtA, (state, meta) => ({ state, meta }));
					const delivered = ctx.publish('after', { ok: true });
					return { a, b, c, delivered };
				},
				fail: async (ctx, roomId, x) => {
					world.x = x;
					throw new LiveError('CONFLICT', 'nope');
				}
			}
		});
		registerRoomActions(moduleName, room);
		return (name) => moduleName + '/room/__action/' + name;
	}

	beforeEach(() => {
		world = { x: 0 };
		ws = mockWs({ id: 'u1' });
		platform = mockPlatform();
		vi.useFakeTimers();
		vi.setSystemTime(1000);
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('rewinds to the snapshot at-or-before the stamped command time', async () => {
		const path = makeRoom('rw1');
		await callAction(ws, platform, path('move'), ['r1', 1]); // records {x:1} near t=1000

		vi.setSystemTime(1500);
		await callAction(ws, platform, path('move'), ['r1', 2]); // records {x:2} near t=1500

		vi.setSystemTime(2000);
		const res = await callAction(ws, platform, path('shoot'), ['r1', 1200]);
		expect(res.ok).toBe(true);
		expect(res.data.state.x).toBe(1);
		expect(res.data.meta.fallback).toBe(false);
		expect(res.data.meta.time).toBeGreaterThanOrEqual(1000);
		expect(res.data.meta.time).toBeLessThan(1200);
		expect(res.data.meta.age).toBeGreaterThanOrEqual(800);
	});

	it('evaluates current state when no command time is supplied', async () => {
		const path = makeRoom('rw2');
		await callAction(ws, platform, path('move'), ['r1', 1]);

		vi.setSystemTime(2000);
		world.x = 7; // out-of-band change since the last record
		const res = await callAction(ws, platform, path('shoot'), ['r1', undefined]);
		expect(res.data.state.x).toBe(7);
		expect(res.data.meta.fallback).toBe(false);
		expect(res.data.meta.age).toBe(0);
	});

	it('falls back to current state when the command predates the ring', async () => {
		const path = makeRoom('rw3');
		vi.setSystemTime(5000);
		await callAction(ws, platform, path('move'), ['r1', 3]);

		world.x = 9;
		const res = await callAction(ws, platform, path('shoot'), ['r1', 100]);
		expect(res.data.state.x).toBe(9);
		expect(res.data.meta.fallback).toBe(true);
		expect(res.data.meta.age).toBe(0);
	});

	it('skips the rewind inside the tolerance window', async () => {
		const path = makeRoom('rw4');
		await callAction(ws, platform, path('move'), ['r1', 1]);

		vi.setSystemTime(1050);
		world.x = 4;
		// 50ms-old stamp inside a 100ms tolerance: current state, no fallback.
		const res = await callAction(ws, platform, path('shoot'), ['r1', 1000, { tolerance: 100 }]);
		expect(res.data.state.x).toBe(4);
		expect(res.data.meta.fallback).toBe(false);
		expect(res.data.meta.age).toBe(0);
	});

	it('does not record a marker for a failed action', async () => {
		const path = makeRoom('rw5');
		await callAction(ws, platform, path('move'), ['r1', 1]); // marker near t=1000

		vi.setSystemTime(1500);
		const failed = await callAction(ws, platform, path('fail'), ['r1', 2]); // mutates, no marker
		expect(failed.ok).toBe(false);

		vi.setSystemTime(1900);
		const res = await callAction(ws, platform, path('shoot'), ['r1', 1600]);
		// At-or-before 1600 resolves to the move marker, not the failed action.
		expect(res.data.state.x).toBe(1);
		expect(res.data.meta.time).toBeLessThan(1500);
	});

	it('evicts by entry count', async () => {
		const path = makeRoom('rw6', { maxEntries: 3 });
		for (let i = 0; i < 5; i++) {
			vi.setSystemTime(1000 + i * 100);
			await callAction(ws, platform, path('move'), ['r1', i]);
		}
		vi.setSystemTime(1600);
		// The two oldest markers (t=1000, t=1100) were evicted by the cap.
		const res = await callAction(ws, platform, path('shoot'), ['r1', 1050]);
		expect(res.data.meta.fallback).toBe(true);
	});

	it('evicts by age on record and refuses aged entries on read', async () => {
		const path = makeRoom('rw7', { maxAgeMs: 300 });
		await callAction(ws, platform, path('move'), ['r1', 1]); // t~1000

		vi.setSystemTime(1500);
		await callAction(ws, platform, path('move'), ['r1', 2]); // evicts t=1000 on record

		const missOld = await callAction(ws, platform, path('shoot'), ['r1', 1050]);
		expect(missOld.data.meta.fallback).toBe(true);

		// The t=1500 marker exists, but by t=1900 it is older than the window:
		// the read side must refuse it too.
		vi.setSystemTime(1900);
		const missAged = await callAction(ws, platform, path('shoot'), ['r1', 1550]);
		expect(missAged.data.meta.fallback).toBe(true);
	});

	it('evicts the least-recently-used room topic at the topic cap', async () => {
		const path = makeRoom('rw8', { maxTopics: 2 });
		await callAction(ws, platform, path('move'), ['r1', 1]);
		vi.setSystemTime(1010);
		await callAction(ws, platform, path('move'), ['r2', 2]);
		vi.setSystemTime(1020);
		await callAction(ws, platform, path('move'), ['r3', 3]); // evicts r1's ring

		vi.setSystemTime(1100);
		// Assert the survivor first: a successful shoot also records, and a
		// record on the evicted r1 would re-create its ring and evict the
		// next-coldest topic.
		const r2 = await callAction(ws, platform, path('shoot'), ['r2', 1015]);
		expect(r2.data.meta.fallback).toBe(false);
		expect(r2.data.state.x).toBe(2);
		const r1 = await callAction(ws, platform, path('shoot'), ['r1', 1005]);
		expect(r1.data.meta.fallback).toBe(true);
	});

	it('delivers publishes made inside eval immediately, room-scoped', async () => {
		const path = makeRoom('rw9');
		await callAction(ws, platform, path('move'), ['r1', 5]);

		vi.setSystemTime(1400);
		const res = await callAction(ws, platform, path('fire'), ['r1', 1100]);
		expect(res.ok).toBe(true);
		const boom = platform.published.find((p) => p.event === 'boom');
		expect(boom).toBeDefined();
		expect(boom.topic).toBe('rw9:r1');
		expect(boom.data).toEqual({ at: 5 });
	});

	it('keeps ordinary publish semantics when eval throws: the publish before the throw is delivered', async () => {
		// Same contract as any action that publishes then throws - the eval
		// function is ordinary action code, not a transaction.
		const path = makeRoom('rw10');
		await callAction(ws, platform, path('move'), ['r1', 5]);

		vi.setSystemTime(1400);
		const res = await callAction(ws, platform, path('misfire'), ['r1', 1100]);
		expect(res.ok).toBe(false);
		expect(platform.published.find((p) => p.event === 'boom')).toBeDefined();
	});

	it('survives concurrent compensates on one ctx and keeps ctx.publish intact', async () => {
		const path = makeRoom('rw15');
		await callAction(ws, platform, path('move'), ['r1', 1]); // marker near t=1000
		vi.setSystemTime(1500);
		await callAction(ws, platform, path('move'), ['r1', 2]); // marker near t=1500

		vi.setSystemTime(2000);
		const res = await callAction(ws, platform, path('both'), ['r1', 1200, 1700]);
		expect(res.ok).toBe(true);
		// The first concurrent call rewinds; the second runs while the first
		// holds the flag, so it fails safe like a nested call.
		expect(res.data.a.meta.fallback).toBe(false);
		expect(res.data.a.state.x).toBe(1);
		expect(res.data.b.meta.fallback).toBe(true);
		// The guard unwinds completely: a sequential compensate after the
		// concurrent pair rewinds again.
		expect(res.data.c.meta.fallback).toBe(false);
		expect(res.data.c.state.x).toBe(1);
		// And the action's ordinary publish after both still works.
		expect(res.data.delivered).toBe(true);
		const after = platform.published.find((p) => p.event === 'after');
		expect(after).toBeDefined();
		expect(after.topic).toBe('rw15:r1');
	});

	it('keeps the ring sorted across a backwards wall-clock step', async () => {
		const path = makeRoom('rw16');
		vi.setSystemTime(2000);
		await callAction(ws, platform, path('move'), ['r1', 2]); // marker at t=2000

		// Clock steps back; the new marker is clamped to the newest time so
		// the binary search's sorted invariant holds.
		vi.setSystemTime(1500);
		await callAction(ws, platform, path('move'), ['r1', 3]);

		vi.setSystemTime(2100);
		const res = await callAction(ws, platform, path('shoot'), ['r1', 2050]);
		expect(res.data.meta.fallback).toBe(false);
		// Newest at-or-before the stamp is the clamped marker: x=3, not x=2.
		expect(res.data.state.x).toBe(3);
	});

	it('hands eval a frozen snapshot: mutation throws and history stays intact', async () => {
		const path = makeRoom('rw11');
		await callAction(ws, platform, path('move'), ['r1', 5]);

		vi.setSystemTime(1400);
		const res = await callAction(ws, platform, path('mutate'), ['r1', 1100]);
		expect(res.ok).toBe(false); // strict-mode write to a frozen object throws

		const again = await callAction(ws, platform, path('shoot'), ['r1', 1100]);
		expect(again.data.state.x).toBe(5);
	});

	it('runs every nested compensate against current state, marked as fallback', async () => {
		const path = makeRoom('rw12');
		await callAction(ws, platform, path('move'), ['r1', 5]);

		vi.setSystemTime(1400);
		const res = await callAction(ws, platform, path('nested'), ['r1', 1100]);
		expect(res.ok).toBe(true);
		expect(res.data.outerMeta.fallback).toBe(false);
		expect(res.data.first.fallback).toBe(true);
		expect(res.data.first.age).toBe(0);
		// The second sibling nested call must be detected too - the flag is
		// restored after the first, never cleared.
		expect(res.data.second.fallback).toBe(true);
		expect(res.data.second.age).toBe(0);
	});

	it('rejects an async capture loudly instead of recording a thenable', async () => {
		const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		try {
			const path = makeRoom('rw17', {}, async () => ({ x: 1 }));
			// Record path: contained, warns once, action result survives.
			const moved = await callAction(ws, platform, path('move'), ['r1', 1]);
			expect(moved.ok).toBe(true);
			expect(errSpy).toHaveBeenCalledTimes(1);
			// Fresh-eval path: loud.
			const res = await callAction(ws, platform, path('shoot'), ['r1', undefined]);
			expect(res.ok).toBe(false);
		} finally {
			errSpy.mockRestore();
		}
	});

	it('contains a throwing capture on record and warns once', async () => {
		const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		try {
			let captureCalls = 0;
			const path = makeRoom('rw13', {}, () => {
				captureCalls++;
				throw new Error('capture boom');
			});
			const first = await callAction(ws, platform, path('move'), ['r1', 1]);
			expect(first.ok).toBe(true); // the action's own result survives
			const second = await callAction(ws, platform, path('move'), ['r1', 2]);
			expect(second.ok).toBe(true);
			expect(captureCalls).toBe(2);
			expect(errSpy).toHaveBeenCalledTimes(1);
		} finally {
			errSpy.mockRestore();
		}
	});

	it('propagates a throwing capture on the fresh-eval path', async () => {
		const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		try {
			const path = makeRoom('rw14', {}, () => {
				throw new Error('capture boom');
			});
			// No command time: compensate needs a fresh capture and must be loud.
			const res = await callAction(ws, platform, path('shoot'), ['r1', undefined]);
			expect(res.ok).toBe(false);
		} finally {
			errSpy.mockRestore();
		}
	});
});

describe('live.multiplayer history pass-through', () => {
	it('compensates inside a multiplayer action', async () => {
		const world = { x: 0 };
		const mp = live.multiplayer({
			topic: (ctx, roomId) => 'mph:' + roomId,
			topicArgs: 1,
			history: { capture: () => ({ ...world }) },
			actions: {
				move: async (ctx, roomId, x) => {
					world.x = x;
					return x;
				},
				shoot: async (ctx, roomId, firedAt) =>
					ctx.compensate(firedAt, (state, meta) => ({ state, meta }))
			}
		});
		registerRoomActions('mph', mp);

		const ws = mockWs({ id: 'u1' });
		const platform = mockPlatform();
		vi.useFakeTimers();
		vi.setSystemTime(1000);
		try {
			await callAction(ws, platform, 'mph/room/__action/move', ['r1', 1]);
			vi.setSystemTime(1500);
			await callAction(ws, platform, 'mph/room/__action/move', ['r1', 2]);
			vi.setSystemTime(2000);
			const res = await callAction(ws, platform, 'mph/room/__action/shoot', ['r1', 1200]);
			expect(res.ok).toBe(true);
			expect(res.data.state.x).toBe(1);
			expect(res.data.meta.fallback).toBe(false);
		} finally {
			vi.useRealTimers();
		}
	});
});
