import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createJitterDispatch } from '../src/client/jitter-dispatch.js';
import { setRuntimeEnv, resetRuntimeEnv } from '../src/client-runtime.js';

// Drive the client runtime seam: a controllable RNG (so the rolled delay is
// deterministic) + a manual timer registry (so we fire/clear on demand).
describe('createJitterDispatch (de-herd dispatch)', () => {
	let timers;
	let nextId;
	let rngValue;
	let applied;

	beforeEach(() => {
		timers = new Map();
		nextId = 1;
		rngValue = 0.5;
		applied = [];
		setRuntimeEnv(
			{
				rng: { float: () => rngValue },
				timers: {
					set: (cb, ms) => { const id = nextId++; timers.set(id, { cb, ms }); return id; },
					clear: (id) => { timers.delete(id); }
				}
			},
			{ force: true }
		);
	});
	afterEach(() => resetRuntimeEnv());

	const apply = (env) => applied.push(env);
	const events = () => applied.map((e) => e.event);
	const onlyTimer = () => [...timers.values()][0];
	const fireAll = () => { for (const [id, t] of [...timers]) { timers.delete(id); t.cb(); } };

	it('dispatches a non-jittered frame immediately', () => {
		const { dispatch } = createJitterDispatch(apply);
		dispatch({ event: 'a' });
		dispatch({ event: 'b', j: 0 });
		expect(events()).toEqual(['a', 'b']);
		expect(timers.size).toBe(0);
	});

	it('defers a jittered frame by random()*j and fires on the timer', () => {
		rngValue = 0.5;
		const { dispatch } = createJitterDispatch(apply);
		dispatch({ event: 'x', j: 1000 });
		expect(applied).toEqual([]); // not applied yet
		expect(timers.size).toBe(1);
		expect(onlyTimer().ms).toBe(500); // 0.5 * 1000
		fireAll();
		expect(events()).toEqual(['x']);
	});

	it('clamps the honored window to 60000ms', () => {
		rngValue = 0.9999;
		const { dispatch } = createJitterDispatch(apply);
		dispatch({ event: 'big', j: 999999 });
		expect(onlyTimer().ms).toBeCloseTo(0.9999 * 60000, 5);
		expect(onlyTimer().ms).toBeLessThanOrEqual(60000);
	});

	it('holds later frames behind a pending deferral and flushes them in arrival order (FIFO)', () => {
		const { dispatch } = createJitterDispatch(apply);
		dispatch({ event: 'A', j: 1000 }); // defers
		dispatch({ event: 'B' }); // held, NOT applied now
		dispatch({ event: 'C', j: 5000 }); // held, does NOT start its own timer
		expect(applied).toEqual([]);
		expect(timers.size).toBe(1); // only A's timer
		fireAll();
		expect(events()).toEqual(['A', 'B', 'C']); // arrival order preserved
	});

	it('clear() drops a pending deferral (held frames never apply, timer cleared)', () => {
		const { dispatch, clear } = createJitterDispatch(apply);
		dispatch({ event: 'A', j: 1000 });
		dispatch({ event: 'B' });
		clear();
		expect(timers.size).toBe(0);
		fireAll(); // nothing left to fire
		expect(applied).toEqual([]);
	});

	it('overflowing the hold queue flushes immediately + clears the timer', () => {
		const { dispatch } = createJitterDispatch(apply);
		dispatch({ event: 'first', j: 1000 }); // defers, queue=[first]
		for (let i = 0; i < 1024; i++) dispatch({ event: 'n' + i }); // the 1024th sees a full queue -> flush + apply
		expect(applied.length).toBe(1 + 1024); // everything drained, in order
		expect(applied[0].event).toBe('first');
		expect(applied[applied.length - 1].event).toBe('n1023');
		expect(timers.size).toBe(0); // pending timer was cleared on overflow flush
	});

	it('a fresh deferral starts after a flush (state resets)', () => {
		const { dispatch } = createJitterDispatch(apply);
		dispatch({ event: 'A', j: 1000 });
		fireAll();
		expect(events()).toEqual(['A']);
		// second jittered frame defers independently
		dispatch({ event: 'B', j: 2000 });
		expect(onlyTimer().ms).toBe(1000); // 0.5 * 2000
		fireAll();
		expect(events()).toEqual(['A', 'B']);
	});
});
