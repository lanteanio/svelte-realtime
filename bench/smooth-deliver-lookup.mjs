// @ts-check
//
// Benchmarks the owner tick's first-sight catch-up source on the interest path.
// Run with: node bench/smooth-deliver-lookup.mjs
//
// The delivery walk needs the current state of any in-range entity that did not
// move this tick. Two ways to provide it:
//
//   A (rebuild): materialize a Map over the full post-drain catalog every moving
//     tick - O(entities) allocations + inserts per tick regardless of how many
//     catch-ups actually happen.
//   B (lookup): read the authority's own entity map through a closure at the few
//     keys the walk actually needs - no per-tick materialization.
//
// The catch-up branch fires only for entities that just entered a subscriber's
// area of interest, so the realistic lookup count per tick is tiny next to the
// catalog size - which is why A's cost scales with the lobby and B's with the
// actual catch-up traffic.

function formatNs(ns) {
	if (ns < 1000) return ns.toFixed(1) + 'ns';
	if (ns < 1e6) return (ns / 1000).toFixed(2) + 'us';
	return (ns / 1e6).toFixed(2) + 'ms';
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

/** The authority's entity map + the derived per-tick catalog array, as the tick sees them. */
function makeWorld(n) {
	const entities = new Map();
	for (let i = 0; i < n; i++) {
		entities.set('e' + i, { state: { x: i % 997, y: (i * 31) % 997 }, ws: null });
	}
	const catalog = [];
	for (const [key, e] of entities) catalog.push({ key, state: e.state });
	return { entities, catalog };
}

const SUBSCRIBERS = 64;
const LOOKUPS_PER_SUB = 2; // first-sight catch-ups per subscriber per tick (entities newly in range)
const TICKS = 200;

console.log('entities | rebuild map/tick (A) | authority lookup (B) | A/B');
for (const n of [500, 2000, 8000]) {
	const { entities, catalog } = makeWorld(n);
	// The keys each subscriber catches up on this tick (deterministic spread).
	const wanted = [];
	for (let s = 0; s < SUBSCRIBERS; s++) {
		for (let l = 0; l < LOOKUPS_PER_SUB; l++) wanted.push('e' + ((s * 131 + l * 977) % n));
	}
	let sink = 0;

	const a = bestMedian(() => {
		for (let t = 0; t < TICKS; t++) {
			const catalogByKey = new Map();
			for (let i = 0; i < catalog.length; i++) catalogByKey.set(catalog[i].key, catalog[i].state);
			for (const key of wanted) {
				const st = catalogByKey.get(key);
				if (st !== undefined) sink += st.x;
			}
		}
	}, 30);

	const b = bestMedian(() => {
		const lookup = (key) => {
			const e = entities.get(key);
			return e === undefined ? undefined : e.state;
		};
		for (let t = 0; t < TICKS; t++) {
			for (const key of wanted) {
				const st = lookup(key);
				if (st !== undefined) sink += st.x;
			}
		}
	}, 30);

	const perTickA = (a.median * 1e6) / TICKS;
	const perTickB = (b.median * 1e6) / TICKS;
	console.log(
		String(n).padStart(8) + ' | ' +
		formatNs(perTickA).padStart(20) + ' | ' +
		formatNs(perTickB).padStart(20) + ' | ' +
		(perTickA / perTickB).toFixed(1) + 'x'
	);
	if (sink === Infinity) console.log(sink); // keep the loops observable
}
