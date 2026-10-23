// @ts-check
//
// Per-message and per-delivery cost of realtime({ authorizeDelivery }).
// Run with: node bench/delivery-authorization.mjs (--check for a short smoke run)
//
// Measures:
// 1. The connection hook guard on every message once the policy is
//    installed (the only per-message work a policy adds to the hooks).
// 2. One adapter policy call for an attributed stream frame: descriptor,
//    live context and the application's (trivial, synchronous) answer.
// 3. The hooks of a second realtime() call with the same policy (equal
//    function and options): no switch.
// 4. Switching to a newer policy once, and the refused hooks of the
//    retired one afterwards (1011 close; the stale diagnostic logs once).
// Without a policy realtime() returns the plain hooks, so there is no
// per-message cost to measure; the script asserts that instead.

import { readFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { realtime, message, unsubscribe } from '../src/server.js';
import {
	configureDeliveryAuthorization,
	ensureDeliveryAuthorization,
	guardDeliveryAuthorization,
	beginDeliveryAdmission,
	endDeliveryAdmission
} from '../src/server/delivery-authorization.js';

const checkOnly = process.argv.includes('--check');
const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const N = checkOnly ? 1_000 : 2_000_000;
const WARMUP = checkOnly ? 100 : 200_000;
const ROUNDS = checkOnly ? 1 : 5;

/** @param {() => unknown} fn */
function measure(fn) {
	for (let i = 0; i < WARMUP; i++) fn();
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

console.log(`svelte-realtime ${version} delivery authorization benchmarks`);
console.log(`Runtime: Node ${process.version}, ${process.platform}/${process.arch}`);
const cpu = cpus();
console.log(`CPU: ${JSON.stringify(cpu[0]?.model ?? 'unknown')}; logical cores: ${cpu.length}`);
console.log(`Command argv: ${JSON.stringify([process.execPath, ...process.execArgv, ...process.argv.slice(1)])}`);
console.log('='.repeat(50));

// The decisions must be real before timing them.
if (base.callback(ws, frame) !== true) throw new Error('policy call did not admit');
if (guardDeliveryAuthorization(ws, view, policy, false) !== true) throw new Error('guard refused an installed policy');
// A record whose hooks never run does not take over.
configureDeliveryAuthorization(() => false, undefined);
if (base.callback(ws, frame) !== true) throw new Error('an unmounted policy took over');

const alias = /** @type {any} */ (configureDeliveryAuthorization(policy.authorize, undefined));
if (guardDeliveryAuthorization(ws, view, alias, false) !== true) throw new Error('an equal policy was refused');

/** @type {Record<string, number[]>} */
const rows = { 'empty loop': [], 'guard per message': [], 'policy call per delivery': [], 'guard, equal policy': [], 'switch to newer policy': [], 'guard, retired policy': [] };
for (let round = 0; round < ROUNDS; round++) {
	rows['empty loop'].push(measure(() => {}));
	rows['guard per message'].push(measure(() => guardDeliveryAuthorization(ws, view, policy, false)));
	rows['policy call per delivery'].push(measure(() => base.callback(ws, frame)));
	rows['guard, equal policy'].push(measure(() => guardDeliveryAuthorization(ws, view, alias, false)));
}

// Switching logs one warning per switch and retires the replaced record.
const warn = console.warn, error = console.error;
console.warn = console.error = () => {};
const switches = checkOnly ? 10 : 10_000;
// The last record answers a sentinel, so the check below can tell it decided.
const records = Array.from({ length: switches }, (_, i) => /** @type {any} */ (configureDeliveryAuthorization(i === switches - 1 ? () => 'newest' : () => true, undefined)));
const switchStart = process.hrtime.bigint();
for (const record of records) guardDeliveryAuthorization(ws, view, record, false);
rows['switch to newer policy'].push(Number(process.hrtime.bigint() - switchStart) / switches);
const retiredWs = { getUserData: () => ({ id: 'u' }), ended: 0, end() { this.ended++; } };
if (guardDeliveryAuthorization(retiredWs, view, policy, false) !== false || retiredWs.ended !== 1) throw new Error('a retired policy was served');
for (let round = 0; round < ROUNDS; round++) rows['guard, retired policy'].push(measure(() => guardDeliveryAuthorization(retiredWs, view, policy, false)));
console.warn = warn; console.error = error;
if (base.callback(ws, frame) !== 'newest') throw new Error('the newest policy did not decide');
console.log('no policy: realtime({}) returns the plain message and unsubscribe hooks');
for (const [label, values] of Object.entries(rows)) {
	const sorted = [...values].sort((a, b) => a - b);
	console.log(label.padEnd(26), 'median', sorted[Math.floor(sorted.length / 2)].toFixed(1), 'ns', ' rounds', values.map((v) => v.toFixed(1)).join(' / '));
}
console.log(checkOnly ? 'Check passed.' : 'Done.');
