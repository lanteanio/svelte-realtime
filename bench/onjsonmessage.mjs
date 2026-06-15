// onJsonMessage perf gate. Quantifies the win from the adapter's parsed-`msg`
// forwarding: with the field set, realtime's onJsonMessage skips its own
// TextDecoder + JSON.parse and dispatches the forwarded value directly.
// Without it, realtime falls back to local parsing.
//
//   Baseline: ctx has no `msg` field (older adapter, or frame outside the
//             adapter's 8192/prefix fast-path window). Realtime runs the
//             full TextDecoder + JSON.parse + object-guard before dispatch.
//   Variant:  ctx has the adapter-forwarded `msg` field. Realtime uses it
//             directly; the parse step is skipped entirely.
//
// Pure JS, no uWS, no real WS, no network. Deterministic, repeatable, runs
// in < 200 ms.
//
// Expected: variant is meaningfully faster on a per-frame basis. The
// absolute number matters for cursor-style high-rate frames (60-120 Hz per
// client) where every microsecond on the hot path adds up. The credo says
// "single-digit-percent regressions on hot primitives are blockers"; this
// is the opposite -- a measurable improvement on the same hot primitive.

import { performance } from 'node:perf_hooks';
import { createMessage } from '../src/server.js';

const textEncoder = new TextEncoder();

function toArrayBuffer(obj) {
	return textEncoder.encode(JSON.stringify(obj)).buffer;
}

function mockPlatform() {
	return {
		publish() {},
		send() {},
		batch() {},
		pressure: null
	};
}

const ws = {};

function benchDispatch({ withForwardedMsg, iterations, payload }) {
	let received = 0;
	const hook = createMessage({
		onJsonMessage() { received++; }
	});
	const platform = mockPlatform();
	const bytes = toArrayBuffer(payload);
	const ctx = withForwardedMsg
		? { data: bytes, isBinary: false, msg: payload, platform }
		: { data: bytes, isBinary: false, platform };

	// Warmup so V8 JITs the dispatch path.
	for (let i = 0; i < 5000; i++) hook(ws, ctx);

	const start = performance.now();
	for (let i = 0; i < iterations; i++) hook(ws, ctx);
	const elapsed = performance.now() - start;

	if (received < iterations) {
		throw new Error('bench invariant: every iteration should dispatch ' +
			'(received=' + received + ', iterations=' + iterations + ')');
	}
	return (elapsed * 1e6) / iterations;  // ns/dispatch
}

function median(xs) {
	const s = [...xs].sort((a, b) => a - b);
	const n = s.length;
	return n % 2 ? s[(n - 1) >> 1] : (s[n / 2 - 1] + s[n / 2]) / 2;
}

function runScenario({ name, payload }) {
	const ROUNDS = 7;
	const ITER = 50000;
	const baseline = [];
	const variant = [];

	for (let r = 0; r < ROUNDS; r++) {
		baseline.push(benchDispatch({ withForwardedMsg: false, iterations: ITER, payload }));
		variant.push(benchDispatch({ withForwardedMsg: true, iterations: ITER, payload }));
	}

	const aMed = median(baseline);
	const bMed = median(variant);
	const delta = ((bMed - aMed) / aMed) * 100;
	const speedup = aMed / bMed;

	console.log('\n' + name);
	console.log('  baseline (no `msg` -> realtime parses)        median ' + aMed.toFixed(0).padStart(5) + ' ns/dispatch');
	console.log('  variant  (adapter forwards `msg`, skip parse) median ' + bMed.toFixed(0).padStart(5) + ' ns/dispatch');
	console.log('  delta    ' + (delta >= 0 ? '+' : '') + delta.toFixed(2) + '%   speedup ' + speedup.toFixed(2) + 'x');
}

console.log('onJsonMessage dispatch: parsed-msg fast path vs. local-parse fallback');

runScenario({
	name: 'Scenario 1: small cursor envelope (~60 bytes)',
	payload: { type: 'cursor', topic: 'board:abc', data: { x: 410, y: 220 } }
});

runScenario({
	name: 'Scenario 2: presence-snapshot envelope (small, no payload)',
	payload: { type: 'presence-snapshot', topic: 'board:abc' }
});

runScenario({
	name: 'Scenario 3: larger envelope (~400 bytes, mock chat-like frame)',
	payload: {
		type: 'chat',
		topic: 'room:lobby',
		data: {
			id: 'msg-019283746',
			user: { id: 'u42', name: 'Some User', color: '#abcdef' },
			text: 'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris.',
			ts: Date.now()
		}
	}
});
