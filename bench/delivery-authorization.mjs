// @ts-check
//
// Per-message and per-delivery cost of realtime({ authorizeDelivery }).
// Run with: node bench/delivery-authorization.mjs
//
// Measures:
// 1. The connection hook guard on every message once the policy is
//    installed (the only per-message work a policy adds to the hooks).
// 2. One adapter policy call for an attributed stream frame: descriptor,
//    live context and the application's (trivial, synchronous) answer.
// Without a policy realtime() returns the plain hooks, so there is no
// per-message cost to measure; the script asserts that instead.

import { realtime, message, unsubscribe } from '../src/server.js';
import {
	configureDeliveryAuthorization,
	ensureDeliveryAuthorization,
	guardDeliveryAuthorization,
	beginDeliveryAdmission,
	endDeliveryAdmission
} from '../src/server/delivery-authorization.js';

const N = 2_000_000;
const ROUNDS = 5;

/** @param {() => unknown} fn */
function measure(fn) {
	for (let i = 0; i < 200_000; i++) fn();
	const start = process.hrtime.bigint();
	for (let i = 0; i < N; i++) fn();
	return Number(process.hrtime.bigint() - start) / N;
}

const plain = realtime({});
if (plain.message !== message || plain.unsubscribe !== unsubscribe) throw new Error('realtime({}) wrapped a hook');

/** @type {any} */
const base = {
	connections: 0,
	publish() { return true; },
	authorizeDelivery(/** @type {any} */ callback) { base.callback = callback; }
};
const view = Object.create(base);
const policy = /** @type {any} */ (configureDeliveryAuthorization(() => true, undefined));
ensureDeliveryAuthorization(base, policy);
const ws = { getUserData: () => ({ id: 'u' }), end() {} };
const token = beginDeliveryAdmission(ws, 'scans:e1', 'scan/log', ['e1']);
endDeliveryAdmission(ws, 'scans:e1', 'scan/log', ['e1'], true, token);
const frame = { kind: 'message', topic: 'scans:e1', event: 'created', data: 1, binary: false };

const rows = { 'empty loop': [], 'guard per message': [], 'policy call per delivery': [] };
for (let round = 0; round < ROUNDS; round++) {
	rows['empty loop'].push(measure(() => {}));
	rows['guard per message'].push(measure(() => guardDeliveryAuthorization(ws, view, policy, false)));
	rows['policy call per delivery'].push(measure(() => base.callback(ws, frame)));
}
console.log('no policy: realtime({}) returns the plain message and unsubscribe hooks');
for (const [label, values] of Object.entries(rows)) {
	const sorted = [...values].sort((a, b) => a - b);
	console.log(label.padEnd(26), 'median', sorted[Math.floor(sorted.length / 2)].toFixed(1), 'ns', ' rounds', values.map((v) => v.toFixed(1)).join(' / '));
}
