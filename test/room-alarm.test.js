// live.room({ alarm }) - a durable alarm declared on a room. The promise already
// shipped in the README, server.d.ts, and the ctx.setAlarm error string; this
// proves it works: the data stream carries the alarm option (so the loader
// dispatch binds ctx.setAlarm), a room ACTION arms the alarm durably keyed to
// the data stream's registry path (<base>/__data), and the cross-restart poll
// recovers it by re-resolving onAlarm at that same path.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { live, configureAlarm, _resetAlarms } from '../src/server.js';
import { _pollAlarms } from '../src/server/alarm.js';
import { state, registry } from '../src/server/state.js';
import { mockPlatform } from './helpers/mock-platform.js';

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

function mkCtx(id, platform) {
	const cap = () => {};
	return { user: { id }, platform, publish: cap, _publishWire: cap };
}

function memStore() {
	const rows = new Map();
	return {
		rows,
		set: (t, at, meta) => { rows.set(t, { at, meta: meta ?? null }); },
		delete: (t) => { const had = rows.has(t); rows.delete(t); return had; },
		due: (now) => [...rows.entries()].filter(([, r]) => r.at <= now).map(([t, r]) => ({ topic: t, at: r.at, meta: r.meta }))
	};
}

describe('live.room({ alarm })', () => {
	let platform, savedCron;
	const registered = [];

	beforeEach(() => {
		savedCron = state.cronPlatform;
		platform = mockPlatform();
		state.cronPlatform = platform;
	});
	afterEach(() => {
		_resetAlarms();
		configureAlarm(null);
		state.cronPlatform = savedCron;
		for (const p of registered) registry.delete(p);
		registered.length = 0;
	});

	function mkRoom(extra = {}) {
		return live.room({ topic: (ctx, id) => 'game:' + id, topicArgs: 1, init: async () => [], ...extra });
	}

	it('carries the alarm option on the data stream so the loader dispatch binds setAlarm', () => {
		const onAlarm = () => {};
		const game = mkRoom({ alarm: { onAlarm } });
		expect(game.__dataStream.__streamOptions.alarm).toBeTruthy();
		expect(game.__dataStream.__streamOptions.alarm.onAlarm).toBe(onAlarm);
		// A plain room declares no alarm - byte-identical stream options.
		expect(mkRoom().__dataStream.__streamOptions.alarm).toBeUndefined();
	});

	it('rejects an invalid alarm config with a room-flavored error', () => {
		expect(() => mkRoom({ alarm: 5 })).toThrow(/live\.room\(\) alarm must be an object/);
		expect(() => mkRoom({ alarm: {} })).toThrow(/onAlarm/);
		expect(() => mkRoom({ alarm: { onAlarm: () => {}, misfireMs: -1 } })).toThrow(/misfireMs/);
		expect(() => mkRoom({ alarm: { onAlarm: () => {} } })).not.toThrow();
	});

	it('a room action arms a durable alarm keyed to the data stream registry path (<base>/__data)', async () => {
		const at = Date.now() + 50_000; // far future: only the durable row, no fire during the test
		const game = mkRoom({
			alarm: { onAlarm: () => {} },
			actions: { arm: async (ctx, id) => { ctx.setAlarm(at); } }
		});
		// Registration captures the base module path (exactly as codegen / the harness do).
		game.__setEnumId('rooms/game');
		const store = memStore();
		configureAlarm({ store });

		await game.__actions.arm(mkCtx('alice', platform), '7');
		await tick();

		const row = store.rows.get('game:7');
		expect(row).toBeTruthy();
		expect(row.at).toBe(at);
		// The durable row points at the data stream's registry key so recovery works.
		expect(row.meta).toEqual({ path: 'rooms/game/__data', tenantId: null });
	});

	it('the cross-restart poll recovers a room alarm by re-resolving onAlarm at <base>/__data', async () => {
		let fired = null;
		const game = mkRoom({ alarm: { onAlarm: (c) => { fired = c; } } });
		// The data stream is registered under <base>/__data (as codegen / the harness do).
		registry.set('rooms/game/__data', game.__dataStream);
		registered.push('rooms/game/__data');
		const store = memStore();
		configureAlarm({ store });
		// A durable row left by a pre-restart arm: overdue, no in-memory _pending entry.
		store.set('game:7', Date.now() - 1000, { path: 'rooms/game/__data', tenantId: null });

		await _pollAlarms();

		expect(fired).not.toBeNull();
		expect(typeof fired.publish).toBe('function'); // a real ctx was rebuilt
		expect(store.rows.has('game:7')).toBe(false); // claimed, single-fire
	});

	it('live.multiplayer forwards alarm to its underlying room', () => {
		const onAlarm = () => {};
		const board = live.multiplayer({ topic: (ctx, id) => 'board:' + id, topicArgs: 1, alarm: { onAlarm } });
		expect(board.__dataStream.__streamOptions.alarm.onAlarm).toBe(onAlarm);
	});
});
