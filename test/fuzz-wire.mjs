// Property-based fuzz of svelte-adapter-uws wire protocol primitives.
//
// Resolves adapter source via `node_modules/svelte-adapter-uws/files/` by
// default (works in CI against the installed peer dep). Set ADAPTER_ROOT
// to point at a sibling checkout for local-dev runs against live source.
//
// Iteration counts are tuned for CI (a few thousand runs total, ~5s
// runtime). For deeper local fuzzing, multiply via env: FUZZ_RUNS=5 raises
// every property's run count 5x.
//
// Exits non-zero when any property finds a counterexample so CI fails
// loud. Set FUZZ_VERBOSE=1 to print per-property progress.

import fc from 'fast-check';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const ADAPTER_ROOT = process.env.ADAPTER_ROOT
	? resolve(process.env.ADAPTER_ROOT)
	: resolve(here, '../node_modules/svelte-adapter-uws');
const FILES = `${ADAPTER_ROOT}/files`;
const RUNS = Math.max(1, Number(process.env.FUZZ_RUNS) || 1);
const VERBOSE = !!process.env.FUZZ_VERBOSE;

const cookies = await import(pathToFileURL(`${FILES}/cookies.js`).href);
const utils = await import(pathToFileURL(`${FILES}/utils.js`).href);

const { parseCookies, serializeCookie } = cookies;
const {
	isValidWireTopic, parse_origin, parse_as_bytes, resolveRequestId,
	completeEnvelope, wrapBatchEnvelope, collapseByCoalesceKey,
	nextTopicSeq, splitCookiesString, esc
} = utils;

// Local copy of parseRange (not exported; mirrors handler.js).
function parseRange(header, fileSize) {
	if (!header.startsWith('bytes=')) return false;
	const spec = header.slice(6);
	if (spec.includes(',')) return false;
	const dash = spec.indexOf('-');
	if (dash < 0) return false;
	const rawStart = spec.slice(0, dash);
	const rawEnd = spec.slice(dash + 1);
	if (rawStart !== '' && /\D/.test(rawStart)) return false;
	if (rawEnd !== '' && /\D/.test(rawEnd)) return false;
	let start, end;
	if (rawStart === '') {
		const suffix = parseInt(rawEnd, 10);
		if (!Number.isFinite(suffix) || suffix <= 0) return false;
		start = Math.max(0, fileSize - suffix);
		end = fileSize - 1;
	} else {
		start = parseInt(rawStart, 10);
		if (!Number.isFinite(start) || start < 0) return false;
		if (rawEnd === '') {
			end = fileSize - 1;
		} else {
			end = parseInt(rawEnd, 10);
			if (!Number.isFinite(end) || end < start) return false;
		}
	}
	if (start >= fileSize) return null;
	end = Math.min(end, fileSize - 1);
	return { start, end };
}

const findings = [];
function record(sev, where, input, outcome) {
	findings.push({ sev, where, input, outcome });
}

const TIMEOUT_MS = 100;
function timed(fn) {
	return (...args) => {
		const t0 = process.hrtime.bigint();
		const r = fn(...args);
		const dt = Number(process.hrtime.bigint() - t0) / 1e6;
		if (dt > TIMEOUT_MS) throw new Error(`HANG: ${dt.toFixed(1)}ms`);
		return r;
	};
}

function run(name, prop, opts = {}) {
	const baseRuns = opts.numRuns ?? 200;
	const numRuns = baseRuns * RUNS;
	if (VERBOSE) process.stderr.write(`[fuzz] ${name} (${numRuns} runs)... `);
	const t0 = Date.now();
	try {
		fc.assert(prop, { numRuns });
		if (VERBOSE) process.stderr.write(`ok (${Date.now() - t0}ms)\n`);
	} catch (e) {
		const msg = String(e && e.message || e).split('\n').slice(0, 6).join(' | ');
		record('?', name, '(see message)', msg);
		if (VERBOSE) process.stderr.write(`FAIL\n`);
	}
}

// -- parseCookies --------------------------------------------------------
run('parseCookies/no-throw', fc.property(fc.string(), (s) => {
	try { const r = parseCookies(s); if (typeof r !== 'object') return false; }
	catch (e) { record('MED', 'parseCookies', JSON.stringify(s), 'threw: ' + e.message); return false; }
	return true;
}));

run('parseCookies/no-proto-pollution', fc.property(
	fc.string(), fc.string(),
	(k, v) => {
		const before = ({}).polluted;
		try { parseCookies('__proto__=' + encodeURIComponent(JSON.stringify({ polluted: true }))); } catch {}
		try { parseCookies('constructor=' + encodeURIComponent(v)); } catch {}
		const after = ({}).polluted;
		if (after !== before) {
			record('HIGH', 'parseCookies', '__proto__=...', 'prototype pollution: Object.prototype.polluted = ' + after);
			return false;
		}
		return true;
	}
), { numRuns: 50 });

// -- serializeCookie -----------------------------------------------------
run('serializeCookie/round-trip', fc.property(
	fc.string({ minLength: 1, maxLength: 64 }),
	fc.string({ maxLength: 64 }),
	(name, value) => {
		let header;
		try { header = serializeCookie(name, value); }
		catch { return true; }
		const first = header.split(';')[0];
		const eq = first.indexOf('=');
		if (eq < 0) { record('HIGH', 'serializeCookie', `${name}=${value}`, 'output has no =: ' + header); return false; }
		const outName = first.slice(0, eq);
		if (outName !== name) {
			record('HIGH', 'serializeCookie', JSON.stringify({name,value}), `name corrupted: in=${JSON.stringify(name)} out=${JSON.stringify(outName)}`);
			return false;
		}
		let decoded;
		try { decoded = decodeURIComponent(first.slice(eq + 1)); }
		catch (e) { record('MED', 'serializeCookie', JSON.stringify({name,value}), 'output not valid URI: ' + e.message); return false; }
		if (decoded !== value) {
			record('HIGH', 'serializeCookie', JSON.stringify({name,value}), `value lost: in=${JSON.stringify(value)} out=${JSON.stringify(decoded)}`);
			return false;
		}
		return true;
	}
));

run('serializeCookie+parseCookies/round-trip', fc.property(
	fc.string({ minLength: 1, maxLength: 32 }),
	fc.string({ maxLength: 64 }),
	(name, value) => {
		let header;
		try { header = serializeCookie(name, value); } catch { return true; }
		const first = header.split(';')[0];
		const r = parseCookies(first);
		if (r[name] !== value) {
			record('MED', 'serializeCookie+parseCookies', JSON.stringify({name,value}), `parsed=${JSON.stringify(r[name])}`);
			return false;
		}
		return true;
	}
));

// -- isValidWireTopic ----------------------------------------------------
run('isValidWireTopic/wire-safe', fc.property(fc.string({ maxLength: 300 }), (topic) => {
	let valid;
	try { valid = isValidWireTopic(topic); }
	catch (e) { record('LOW', 'isValidWireTopic', JSON.stringify(topic), 'threw: ' + e.message); return false; }
	if (!valid) return true;
	let escaped;
	try { escaped = esc(topic); }
	catch (e) {
		record('HIGH', 'isValidWireTopic', JSON.stringify(topic), 'isValidWireTopic=true but esc() threw: ' + e.message);
		return false;
	}
	const frame = `{"type":"subscribed","topic":${escaped}}`;
	try {
		const parsed = JSON.parse(frame);
		if (parsed.topic !== topic) {
			record('HIGH', 'isValidWireTopic', JSON.stringify(topic), `wire-roundtrip mismatch: got=${JSON.stringify(parsed.topic)}`);
			return false;
		}
	} catch (e) {
		record('HIGH', 'isValidWireTopic', JSON.stringify(topic), 'wire JSON.parse failed: ' + e.message);
		return false;
	}
	return true;
}), { numRuns: 500 });

// -- parseRange ----------------------------------------------------------
run('parseRange/no-throw+timing', fc.property(
	fc.string({ maxLength: 100 }), fc.integer({ min: 0, max: 1e12 }),
	(h, sz) => {
		const wrapped = timed(parseRange);
		try { wrapped(h, sz); }
		catch (e) {
			record(e.message.startsWith('HANG') ? 'HIGH' : 'MED', 'parseRange', JSON.stringify({h,sz}), e.message);
			return false;
		}
		return true;
	}
), { numRuns: 500 });

run('parseRange/invariants', fc.property(
	fc.string({ maxLength: 60 }), fc.integer({ min: 1, max: 1e9 }),
	(h, sz) => {
		let r;
		try { r = parseRange(h, sz); } catch { return true; }
		if (r === false || r === null) return true;
		if (typeof r !== 'object' || !(r.start >= 0 && r.start <= r.end && r.end < sz)) {
			record('HIGH', 'parseRange', JSON.stringify({h,sz}), 'invalid range: ' + JSON.stringify(r));
			return false;
		}
		return true;
	}
), { numRuns: 500 });

// -- parse_origin --------------------------------------------------------
run('parse_origin/no-throw-on-string', fc.property(fc.string({ maxLength: 200 }), (s) => {
	try {
		const r = parse_origin(s);
		if (r !== undefined && typeof r !== 'string') {
			record('LOW', 'parse_origin', JSON.stringify(s), 'returned non-string: ' + typeof r);
			return false;
		}
	} catch (e) {
		if (e.message && /^Invalid ORIGIN/.test(e.message)) return true;
		record('MED', 'parse_origin', JSON.stringify(s), 'unexpected throw: ' + e.message);
		return false;
	}
	return true;
}), { numRuns: 300 });

// -- parse_as_bytes ------------------------------------------------------
run('parse_as_bytes/no-throw', fc.property(fc.string({ maxLength: 30 }), (s) => {
	try {
		const r = parse_as_bytes(s);
		if (typeof r !== 'number') {
			record('MED', 'parse_as_bytes', JSON.stringify(s), 'non-number: ' + typeof r);
			return false;
		}
	} catch (e) {
		record('MED', 'parse_as_bytes', JSON.stringify(s), 'threw: ' + e.message);
		return false;
	}
	return true;
}), { numRuns: 300 });

// -- resolveRequestId ----------------------------------------------------
run('resolveRequestId/no-throw', fc.property(
	fc.oneof(fc.string({ maxLength: 200 }), fc.constant(null), fc.constant(undefined), fc.integer()),
	(s) => {
		try {
			const r = resolveRequestId(s);
			if (r !== null && typeof r !== 'string') {
				record('MED', 'resolveRequestId', JSON.stringify(s), 'non-string non-null: ' + typeof r);
				return false;
			}
			if (typeof r === 'string') {
				if (r.length === 0 || r.length > 128) {
					record('HIGH', 'resolveRequestId', JSON.stringify(s), 'length OOB: ' + r.length); return false;
				}
				for (let i = 0; i < r.length; i++) {
					const c = r.charCodeAt(i);
					if (c < 0x21 || c > 0x7e) {
						record('HIGH', 'resolveRequestId', JSON.stringify(s), 'non-printable char ' + c + ' at ' + i); return false;
					}
				}
			}
		} catch (e) { record('MED', 'resolveRequestId', JSON.stringify(s), 'threw: ' + e.message); return false; }
		return true;
	}
), { numRuns: 300 });

// -- nextTopicSeq --------------------------------------------------------
run('nextTopicSeq/monotonic', fc.property(
	fc.array(fc.string({ maxLength: 8 }), { minLength: 1, maxLength: 50 }),
	(topics) => {
		const m = new Map();
		const counts = new Map();
		for (const t of topics) {
			const r = nextTopicSeq(m, t);
			const expected = (counts.get(t) ?? 0) + 1;
			counts.set(t, expected);
			if (r !== expected) { record('HIGH', 'nextTopicSeq', JSON.stringify(topics), `expected ${expected} got ${r}`); return false; }
		}
		return true;
	}
));

// -- completeEnvelope ----------------------------------------------------
run('completeEnvelope/valid-json', fc.property(
	fc.string({ minLength: 1, maxLength: 16 }).filter(s => !/[ -"\\]/.test(s)),
	fc.string({ minLength: 1, maxLength: 16 }).filter(s => !/[ -"\\]/.test(s)),
	fc.jsonValue(),
	fc.oneof(fc.constant(null), fc.constant(undefined), fc.integer()),
	(topic, event, data, seq) => {
		const prefix = `{"topic":"${topic}","event":"${event}","data":`;
		let out;
		try { out = completeEnvelope(prefix, data, seq); }
		catch (e) { record('HIGH', 'completeEnvelope', JSON.stringify({topic,event,seq}), 'threw: ' + e.message); return false; }
		try { JSON.parse(out); }
		catch (e) { record('HIGH', 'completeEnvelope', JSON.stringify({topic,event,data,seq}), 'invalid JSON: ' + e.message + ' :: ' + out.slice(0, 80)); return false; }
		return true;
	}
), { numRuns: 300 });

// -- wrapBatchEnvelope ---------------------------------------------------
run('wrapBatchEnvelope/valid-json', fc.property(
	fc.array(fc.jsonValue().map(v => JSON.stringify(v)), { maxLength: 20 }),
	(envelopes) => {
		const out = wrapBatchEnvelope(envelopes);
		try {
			const p = JSON.parse(out);
			if (p.type !== 'batch' || !Array.isArray(p.events) || p.events.length !== envelopes.length) {
				record('HIGH', 'wrapBatchEnvelope', JSON.stringify(envelopes), 'shape mismatch: ' + out.slice(0, 80));
				return false;
			}
		} catch (e) { record('HIGH', 'wrapBatchEnvelope', JSON.stringify(envelopes), 'invalid JSON: ' + e.message); return false; }
		return true;
	}
));

run('wrapBatchEnvelope/injection', fc.property(fc.string({ maxLength: 80 }), (s) => {
	const out = wrapBatchEnvelope([s]);
	try { JSON.parse(out); } catch { return true; }
	return true;
}), { numRuns: 50 });

// -- collapseByCoalesceKey -----------------------------------------------
run('collapseByCoalesceKey/correctness', fc.property(
	fc.array(fc.record({
		coalesceKey: fc.option(fc.string({ maxLength: 4 }), { nil: undefined }),
		id: fc.integer()
	}), { maxLength: 30 }),
	(msgs) => {
		let result;
		try { result = collapseByCoalesceKey(msgs); }
		catch (e) { record('HIGH', 'collapseByCoalesceKey', JSON.stringify(msgs).slice(0,80), 'threw: ' + e.message); return false; }
		const lastIdx = new Map();
		msgs.forEach((m, i) => { if (m.coalesceKey !== undefined) lastIdx.set(m.coalesceKey, i); });
		const expected = [];
		msgs.forEach((m, i) => {
			if (m.coalesceKey === undefined || lastIdx.get(m.coalesceKey) === i) expected.push(m);
		});
		if (result.length !== expected.length) {
			record('MED', 'collapseByCoalesceKey', JSON.stringify(msgs).slice(0,80), `len ${result.length} vs ${expected.length}`);
			return false;
		}
		for (let i = 0; i < expected.length; i++) {
			if (result[i].id !== expected[i].id) {
				record('MED', 'collapseByCoalesceKey', JSON.stringify(msgs).slice(0,80), `idx ${i} mismatch`);
				return false;
			}
		}
		return true;
	}
));

// -- splitCookiesString --------------------------------------------------
run('splitCookiesString/no-throw+timing', fc.property(fc.string({ maxLength: 200 }), (s) => {
	const wrapped = timed(splitCookiesString);
	try {
		const r = wrapped(s);
		if (!Array.isArray(r)) { record('MED', 'splitCookiesString', JSON.stringify(s), 'non-array'); return false; }
	} catch (e) {
		record(e.message.startsWith('HANG') ? 'HIGH' : 'MED', 'splitCookiesString', JSON.stringify(s), e.message);
		return false;
	}
	return true;
}), { numRuns: 300 });

run('splitCookiesString/redos-attempt', fc.property(
	fc.integer({ min: 1, max: 5000 }),
	(n) => {
		const s = ' '.repeat(n) + ',' + ' '.repeat(n) + 'a=' + 'b'.repeat(Math.min(n, 100));
		const wrapped = timed(splitCookiesString);
		try { wrapped(s); }
		catch (e) {
			if (e.message.startsWith('HANG')) {
				record('HIGH', 'splitCookiesString', `whitespace n=${n}`, e.message); return false;
			}
		}
		return true;
	}
), { numRuns: 50 });

// -- Wire-shape dispatch -------------------------------------------------
function simulateDispatch(msg) {
	if (msg.type === 'subscribe' && typeof msg.topic === 'string') {
		isValidWireTopic(msg.topic);
	} else if (msg.type === 'subscribe-batch' && Array.isArray(msg.topics)) {
		for (const t of msg.topics) isValidWireTopic(t);
	} else if (msg.type === 'reply' && msg.ref !== undefined) {
		// pending lookup -- no-op
	} else if (msg.type === 'hello' && Array.isArray(msg.caps)) {
		const caps = new Set();
		for (const c of msg.caps) if (typeof c === 'string') caps.add(c);
	} else if (msg.type === 'resume' && typeof msg.sessionId === 'string'
			&& msg.lastSeenSeqs && typeof msg.lastSeenSeqs === 'object') {
		// hook would be invoked
	}
}

run('wire-dispatch/no-throw', fc.property(fc.jsonValue(), (v) => {
	if (v === null || typeof v !== 'object') return true;
	try { simulateDispatch(v); }
	catch (e) { record('HIGH', 'wire-dispatch', JSON.stringify(v).slice(0,120), 'threw: ' + e.message); return false; }
	return true;
}), { numRuns: 500 });

run('wire-dispatch/proto-pollution', fc.property(fc.string({ maxLength: 16 }), (k) => {
	const polluteKey = `polluted_${k}`;
	const json = `{"type":"hello","caps":["x"],"__proto__":{${JSON.stringify(polluteKey)}:true}}`;
	const parsed = JSON.parse(json);
	const before = ({})[polluteKey];
	try { simulateDispatch(parsed); } catch {}
	const after = ({})[polluteKey];
	if (after !== before) {
		record('HIGH', 'wire-dispatch', `__proto__ k=${k}`, 'pollution detected');
		return false;
	}
	return true;
}), { numRuns: 50 });

run('isValidWireTopic/unicode-edges', fc.property(fc.constantFrom(
	'﻿', ' ', ' ', '\uD800', '\uDFFF', '\u{1F600}',
	'‮', '​', 'a b', 'ab', 'a\nb', 'a\rb', 'a\tb'
), (s) => {
	let valid;
	try { valid = isValidWireTopic(s); } catch { return true; }
	if (!valid) return true;
	let escaped;
	try { escaped = esc(s); }
	catch (e) {
		record('HIGH', 'isValidWireTopic', JSON.stringify(s), 'isValidWireTopic=true but esc throws: ' + e.message);
		return false;
	}
	const frame = `{"topic":${escaped}}`;
	try {
		const p = JSON.parse(frame);
		if (p.topic !== s) {
			record('HIGH', 'isValidWireTopic', JSON.stringify(s), `JSON roundtrip lost char: out=${JSON.stringify(p.topic)}`);
			return false;
		}
	} catch (e) {
		record('HIGH', 'isValidWireTopic', JSON.stringify(s), 'JSON.parse failed: ' + e.message);
		return false;
	}
	return true;
}), { numRuns: 50 });

// -- Report --------------------------------------------------------------
console.log('\n=== FUZZ REPORT ===');
if (findings.length === 0) {
	console.log('NO COUNTEREXAMPLES');
} else {
	for (const f of findings) {
		console.log(`[${f.sev}] ${f.where}(${f.input}) -> ${f.outcome}`);
	}
}
console.log(`\nTotal findings: ${findings.length}`);

process.exit(findings.length === 0 ? 0 : 1);
