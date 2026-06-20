// @ts-check
//
// Benchmarks for K4 area-of-interest relevancy. Run with: node bench/interest.mjs
//
// Two questions a number, not an assertion, has to answer:
//
//   1. The mega-lobby win: how much does the per-tick relevancy pass cut what each
//      subscriber is delivered, and what does that pass cost, as the entity count
//      climbs from one arena to a whole lobby.
//
//   2. The credo-4 merge blocker: turning interest OFF must cost nothing. The
//      publish loop gains exactly one `rec.interest && updates.length > 0` gate
//      (false) and one `if (relevancy)` gate (false) per tick, plus one extra
//      falsy check per update. This measures that the interest-off publish loop is
//      within noise of the pre-K4 broadcast-all loop.

import { createInterestState } from '../src/server/interest.js';

function formatNs(ns) {
	if (ns < 1000) return ns.toFixed(1) + 'ns';
	if (ns < 1e6) return (ns / 1000).toFixed(2) + 'us';
	return (ns / 1e6).toFixed(2) + 'ms';
}

/**
 * A deterministic catalog of `n` entities moving over a square board (no RNG): a
 * fresh array of fresh state objects each tick, every entity stepped by a stable
 * per-entity velocity. Because the relevancy pass is delta-gated (it delivers an
 * entity only when its state changed since last sent), this models the realistic
 * "everyone is moving" load - the worst case for delivered bandwidth.
 */
function makeMovingCatalog(n, board, t) {
	const catalog = new Array(n);
	for (let i = 0; i < n; i++) {
		const x0 = (i * 1103515245 + 12345) % board;
		const y0 = (i * 1664525 + 1013904223) % board;
		const vx = ((i * 31 + 7) % 17) - 8; // stable per-entity velocity in [-8, 8]
		const vy = ((i * 13 + 3) % 17) - 8;
		catalog[i] = { key: 'e' + i, state: { x: (x0 + vx * t + board) % board, y: (y0 + vy * t + board) % board } };
	}
	return catalog;
}

function bestMedian(fn, trials) {
	const samples = [];
	for (let t = 0; t < trials; t++) {
		const start = performance.now();
		fn();
		samples.push(performance.now() - start);
	}
	samples.sort((a, b) => a - b);
	return { best: samples[0], median: samples[Math.floor(samples.length / 2)] };
}

// --- 1. Mega-lobby cull effectiveness + cost ---------------------------------
//
// A square board scaled with the population so the local density (and the AoI
// radius's reach) stays roughly constant - the realistic case where each player
// sees a bounded neighbourhood no matter how big the lobby grows.

function benchCull() {
	console.log('--- area-of-interest cull (each subscriber centred on its own entity) ---');
	console.log('entities |   compute/tick   | delivered/subscriber | bandwidth saved');
	console.log('-'.repeat(72));
	for (const n of [48, 256, 1024, 4096, 16384]) {
		// Density held ~constant: board area grows with n, radius fixed. With ~n/area
		// density and a radius reach, each subscriber sees a bounded neighbourhood.
		const board = Math.round(Math.sqrt(n) * 220);
		const radius = 500;
		const subscribers = makeMovingCatalog(n, board, 0).map((e) => e.key); // every owner is a subscriber
		const lod = [{ within: 150, rate: 1 }, { within: 320, rate: 3 }, { within: 500, rate: 8 }];
		const state = createInterestState({ radius, position: (s) => ({ x: s.x, y: s.y }), lod });

		// Warm + settle LOD bands across a few moving ticks.
		for (let t = 0; t < 8; t++) state.compute(makeMovingCatalog(n, board, t), subscribers, t);

		// Measure the delivered fraction over a window of MOVING ticks (LOD throttling
		// makes it vary tick to tick; average it).
		let delivered = 0;
		const window = 8;
		for (let t = 8; t < 8 + window; t++) {
			const rel = state.compute(makeMovingCatalog(n, board, t), subscribers, t);
			for (const set of rel.values()) delivered += set.size;
		}
		const avgDeliveredPerSub = delivered / (window * subscribers.length);
		const savedPct = (1 - avgDeliveredPerSub / n) * 100;

		let tick = 100;
		const { best, median } = bestMedian(() => {
			for (let i = 0; i < 5; i++) { state.compute(makeMovingCatalog(n, board, tick), subscribers, tick); tick++; }
		}, 25);
		const perTickBest = (best * 1e6) / 5; // ns per compute() call (includes catalog rebuild)

		console.log(
			String(n).padStart(8) + ' | ' +
			(formatNs(perTickBest) + ' best').padStart(16) + ' | ' +
			(avgDeliveredPerSub.toFixed(1) + ' of ' + n).padStart(20) + ' | ' +
			savedPct.toFixed(2).padStart(6) + '%'
		);
		void median;
	}
	console.log();
}

// --- 2. credo-4: interest-OFF publish loop is free ---------------------------
//
// Replicates the exact shape of _smoothTick's update fan-out for an interest-off
// topic (rec.interest === null, single instance), with and without the K4 gate,
// over a representative tick's worth of updates. A no-op "publish" stands in for
// the real publishWire so the loop overhead is what is measured, not the wire.

function benchInterestOffGate() {
	console.log('--- credo-4: interest-off publish loop overhead (gate must be free) ---');
	const recOff = { interest: null, noEcho: true };
	const cluster = false;
	const updates = [];
	for (let i = 0; i < 64; i++) updates.push({ key: 'e' + i, state: { x: i, y: 0 }, ws: { id: i }, commanded: i % 2 === 0 });

	let sink = 0;
	const publish = (u) => { sink += u.key.length; };

	// The actual K4 interest-off path: the gate computes null, the per-update else
	// runs the unchanged broadcast, the trailing cull loop is skipped.
	function withGate() {
		for (let r = 0; r < 20000; r++) {
			const relevancy = (recOff.interest && updates.length > 0) ? {} : null;
			for (let i = 0; i < updates.length; i++) {
				const u = updates[i];
				if (cluster) { /* unreached */ }
				else if (relevancy) { /* unreached */ }
				else publish(u);
			}
			if (relevancy) { /* unreached */ }
		}
	}
	// The pre-K4 baseline: the same fan-out with no gate at all.
	function baseline() {
		for (let r = 0; r < 20000; r++) {
			for (let i = 0; i < updates.length; i++) publish(updates[i]);
		}
	}

	withGate(); baseline(); // warm
	const g = bestMedian(withGate, 25);
	const b = bestMedian(baseline, 25);
	const perCallG = (g.best * 1e6) / (20000 * updates.length);
	const perCallB = (b.best * 1e6) / (20000 * updates.length);
	const overheadPct = ((g.best - b.best) / b.best) * 100;
	console.log(`with K4 gate: ${formatNs(perCallG)}/update    baseline: ${formatNs(perCallB)}/update`);
	console.log(`overhead:     ${overheadPct.toFixed(2)}%  (target: within measurement noise)`);
	console.log(`(sink ${sink} - keeps the loop from being optimised away)`);
	console.log();
}

console.log('svelte-realtime K4 area-of-interest benchmark');
console.log('='.repeat(72));
console.log();
benchCull();
benchInterestOffGate();
console.log('Done.');
