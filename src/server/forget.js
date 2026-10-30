// @ts-check
//
// `live.forget(userId, opts)`: right-to-erasure. A connection-less server
// action (a sibling of `live.cron` / `live.push`) that purges every trace of a
// user across the framework's in-memory state AND any wired durable store,
// scoped to one tenant. It is NOT reachable from the wire - the app calls it
// from trusted server code, so the app owns the "should this user be erased"
// authorization at the call site. It erases data at rest; it does not forcibly
// disconnect the user (do that from the `onForget` hook or your own socket
// handling if you want the session to end too).
//
// The cascade is a DESCRIPTOR TABLE: one auditable list of `{ name, run }`
// entries, so the purge surface is reviewable in one place and a test fails if
// a known user-keyed in-memory store has no descriptor (forget-completeness -
// a missed store is residual PII). Durable cluster stores (Redis / Postgres)
// ride the pluggable `store` seam, exactly like `live.alarm({ store })` /
// `live.idempotent({ store })`; the realtime layer never imports the durable
// store, it only duck-types `store.purgeUser`.

import { _IS_DEV } from './env.js';
import { wallEpoch, randomUuid, setTimer, clearTimer, setIntervalTimer, clearIntervalTimer } from '../shared/runtime.js';
import { emitOperationalEvent } from '../shared/diagnostic.js';
import { _enterInFlight, _exitInFlight } from './lifecycle.js';
import { _validTenantId, _tenantKey, _isTenancyEnabled } from './tenant.js';
import { _validIdReason, _MAX_USER_ID_LENGTH } from './validate.js';
import { LiveError } from './live-error.js';
import { createHash, createHmac, createSecretKey } from 'node:crypto';
import { _purgePushUser } from './push.js';
import { _purgePresenceUser, _ownerReplayPublisher } from './presence.js';
import { _purgeRateLimitUser } from './rate-limit.js';
import { _purgeIdempotencyUser } from './idempotency.js';
import { _purgeSmoothUser } from './smooth.js';
import { _purgeAggregateCohorts } from './reactive.js';
import { _purgeCrdtDocs } from './crdt.js';
import { _ownerEmit } from './room-owner.js';
import { state } from './state.js';
import { createForgetJobStore } from './forget-jobs.js';
import { _isMemoryDeadLetterStore } from './dead-letter.js';

/**
 * Optional durable forget store (default null = in-memory state only). A wired
 * store erases the user's durable cluster rows (Redis registry / presence /
 * cursor / session / idempotency, Postgres idempotency, ...). Duck-typed:
 * `purgeUser(tenantId, userId, cascade)` returns rows removed as a number, a
 * per-store breakdown object, OR the richer owner-succession envelope
 * `{ rowsAffected?, ownerSuccessions? }`. The envelope (detected by an
 * `ownerSuccessions` array) carries the `:owner` changes the store's cluster-wide
 * owner eviction produced for rooms this instance could not resolve locally (a
 * remote-only room, or an identity still connected elsewhere whose local
 * connection-count never reached zero here); realtime publishes each so live
 * subscribers and resumers see the successor rather than the erased owner. Each
 * entry is `{ topic, owner, reason }` (owner null + reason 'vacated' when the room
 * emptied). The extensions `createForgetStore(...)` builds one; the realtime layer
 * never imports it. Set via `configureForget({ store })`.
 * @type {{ purgeUser: (tenantId: string | null, userId: string, cascade: any) => Promise<number | Record<string, number> | { rowsAffected?: number | Record<string, number>, ownerSuccessions?: Array<{ topic: string, owner: string | null, reason: string }> }> } | null}
 */
let _forgetStore = null;

/**
 * Optional platform (default null). Supplies the cluster presence Redis handle
 * and aggregate reset publication; local refs can use their captured platform.
 * Single-instance deployments leave it null. Set via `configureForget({ platform })`.
 * @type {any}
 */
let _forgetPlatform = null;

/** @type {import('node:crypto').KeyObject | null} */
let _forgetHashKey = null;

/**
 * Optional erasure job store (default null = no job records). Duck-typed:
 * `begin`, `renew`, `claim`, `complete`, `fail`, `abandon`, `list` and `due`,
 * each sync or async. `createForgetJobStore()` is the in-memory reference;
 * durable stores implement the same methods. Set via `configureForget({ jobs })`.
 * @type {any}
 */
let _forgetJobs = null;

const _JOB_METHODS = ['begin', 'renew', 'claim', 'complete', 'fail', 'abandon', 'list', 'due'];

// After this many runs a job (or a process's in-memory retry of it) that still
// fails stops running by itself and is reported, so work that cannot finish
// does not retry forever.
const _MAX_ATTEMPTS = 24;

const _MAX_TIMEOUT_MS = 600_000;
const _MIN_RESUME_INTERVAL_MS = 1000;
const _MAX_RESUME_INTERVAL_MS = 24 * 60 * 60_000;

// A run's lease on a job lasts `_LEASE_MS` and is renewed every `_RENEW_MS`
// while the run is going. A run older than `_MAX_RUN_MS` stops renewing and is
// reported, so a hung run lets go of its job instead of holding it forever.
const _LEASE_MS = 60_000;
const _RENEW_MS = 20_000;
const _MAX_RUN_MS = 15 * 60_000;

// In-memory erasure this process still owes: at most this many jobs.
const _MAX_LOCAL_JOBS = 10_000;

/** Jobs a run of this process is working on. */
const _running = new Set();

/**
 * Jobs whose `begin` failed, so their caller was told nothing was erased, but
 * whose record may have landed anyway (a lost reply, a timeout). Each is
 * abandoned when the record shows up, so it never runs later; after a few
 * tries a record that never landed is forgotten.
 * @type {Map<string, { runId: string, tries: number }>}
 */
const _refused = new Map();
const _MAX_REFUSED = 1000;
const _REFUSED_TRIES = 3;

/**
 * In-memory erasure this process still owes, by job id: the steps left, what
 * running them needs, and when to try again. Only this process can finish
 * them, and a step it finished is never run again here; a process that exits
 * takes this state, and the data it describes, with it.
 * @type {Map<string, { userId: string, userIdHash: string | null, tenantId: string | null, cascade: any, open: Set<string>, attempts: number, retryAt: number, exhausted: boolean }>}
 */
const _localJobs = new Map();

/** @type {any} */
let _localTimer = null;
/** @type {any} */
let _resumeTimer = null;

/**
 * Steps of an erasure any process can finish: the durable store and a
 * dead-letter store other than the built-in in-memory one.
 * @returns {string[]}
 */
function _sharedSteps() {
	/** @type {string[]} */
	const steps = [];
	const dl = state.webhookDeadLetter;
	if (dl && !_isMemoryDeadLetterStore(dl)) steps.push('webhookDeadLetter');
	if (_forgetStore) steps.push('durable');
	return steps;
}

/**
 * In-memory steps of an erasure, which only the calling process can finish.
 * @param {any} cascade @param {string[]} shared
 * @returns {string[]}
 */
function _localSteps(cascade, shared) {
	const steps = _descriptors.map((d) => d.name).filter((name) => !shared.includes(name));
	if (cascade !== null && typeof cascade === 'object' && Array.isArray(cascade.crdt)) steps.push('crdtDocs');
	return steps;
}

/** @param {string} step */
function _sharedStoreMissing(step) {
	if (step === 'durable') return _forgetStore === null;
	if (step === 'webhookDeadLetter') return !state.webhookDeadLetter;
	return false;
}

/**
 * The longest an erasure waits on any one store call (the job record, each
 * surface, the durable store, the outcome) before treating it as failed, or
 * null (the default) to wait as long as the store takes. Set via
 * `configureForget({ timeoutMs })`.
 * @type {number | null}
 */
let _forgetTimeoutMs = null;

const _RETRY_BASE_MS = 1000;
const _RETRY_MAX_MS = 60 * 60_000;
const _JOB_STATUSES = ['pending', 'failed', 'exhausted', 'completed', 'abandoned'];
const _MAX_JOB_LIMIT = 1000;

/** @param {unknown} key @returns {import('node:crypto').KeyObject | null} */
function _readHashKey(key) {
	if (key === null) return null;
	if ((typeof key !== 'string' && !(key instanceof Uint8Array)) ||
		(typeof key === 'string' ? Buffer.byteLength(key, 'utf8') : key.byteLength) < 32) {
		throw new Error('hashKey must be a string or Uint8Array containing at least 32 bytes, or null');
	}
	// KeyObject owns its bytes, so caller mutation cannot rotate a configured key.
	return createSecretKey(key);
}

/**
 * Wait for a store call, at most `_forgetTimeoutMs` when one is configured. A
 * plain value passes through; a call that does not settle in time rejects,
 * while the call itself keeps running, so every erasure surface is idempotent
 * under a late finish. `late` receives the outcome of a call that settles
 * after its timeout, for side effects the caller must not lose.
 * @template T
 * @param {T | Promise<T>} value
 * @param {{ resolved?: (v: T) => void, rejected?: (e: unknown) => void }} [late]
 * @returns {T | Promise<T>}
 */
function _bounded(value, late) {
	const ms = _forgetTimeoutMs;
	if (ms === null || value === null || (typeof value !== 'object' && typeof value !== 'function') || typeof (/** @type {any} */ (value)).then !== 'function') return value;
	return new Promise((resolve, reject) => {
		let timedOut = false;
		const timer = setTimer(() => { timedOut = true; reject(new Error('store call timed out')); }, ms);
		/** @type {Promise<T>} */ (value).then(
			(v) => {
				clearTimer(timer);
				if (!timedOut) resolve(v);
				else if (late?.resolved) { try { late.resolved(v); } catch { /* late side effects are best-effort */ } }
			},
			(e) => {
				clearTimer(timer);
				if (!timedOut) reject(e);
				else if (late?.rejected) { try { late.rejected(e); } catch { /* late side effects are best-effort */ } }
			}
		);
	});
}

/**
 * Configure the forget subsystem. `store` plugs in durable erasure; `platform`
 * supplies the cluster Redis handle. `hashKey` opts audit records into HMAC.
 * `jobs` records each erasure as a resumable job (`true` = in-memory store).
 * `timeoutMs` bounds each store call an erasure waits on. `resumeIntervalMs`
 * runs `resumeForgetJobs()` on that interval while a job store is configured.
 * Omitted settings are retained; `null` clears all of them.
 *
 * @param {{ store?: { purgeUser: Function } | null, platform?: any, hashKey?: string | Uint8Array | null, jobs?: boolean | object | null, timeoutMs?: number | null, resumeIntervalMs?: number | null } | null} config
 */
export function configureForget(config) {
	if (config === null) { _clearForgetConfig(); return; }
	if (typeof config !== 'object') {
		throw new Error('[svelte-realtime] configureForget: config must be an object or null');
	}
	const { store, platform, hashKey, jobs, timeoutMs, resumeIntervalMs } = config;
	if (store === undefined && platform === undefined && hashKey === undefined && jobs === undefined && timeoutMs === undefined && resumeIntervalMs === undefined) {
		throw new Error('[svelte-realtime] configureForget: config must include at least one of store, platform, hashKey, jobs, timeoutMs or resumeIntervalMs');
	}
	if (timeoutMs !== undefined && timeoutMs !== null && (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > _MAX_TIMEOUT_MS)) {
		throw new Error('[svelte-realtime] configureForget: timeoutMs must be an integer from 1 to ' + _MAX_TIMEOUT_MS + ', or null');
	}
	if (resumeIntervalMs !== undefined && resumeIntervalMs !== null &&
		(!Number.isInteger(resumeIntervalMs) || resumeIntervalMs < _MIN_RESUME_INTERVAL_MS || resumeIntervalMs > _MAX_RESUME_INTERVAL_MS)) {
		throw new Error('[svelte-realtime] configureForget: resumeIntervalMs must be an integer from ' + _MIN_RESUME_INTERVAL_MS + ' to ' + _MAX_RESUME_INTERVAL_MS + ', or null');
	}
	if (jobs !== undefined && jobs !== null && typeof jobs !== 'boolean' &&
		(typeof jobs !== 'object' || _JOB_METHODS.some((m) => typeof (/** @type {any} */ (jobs))[m] !== 'function'))) {
		throw new Error('[svelte-realtime] configureForget: jobs must be true, null or a store implementing ' + _JOB_METHODS.join(', '));
	}
	if (store !== undefined && store !== null && (typeof store !== 'object' || typeof store.purgeUser !== 'function')) {
		throw new Error('[svelte-realtime] configureForget: store must implement purgeUser(tenantId, userId, cascade)');
	}
	// Validate everything before applying any configuration change.
	const nextHashKey = hashKey === undefined ? _forgetHashKey : _readHashKey(hashKey);
	if (store !== undefined) _forgetStore = store;
	if (platform !== undefined) _forgetPlatform = platform;
	_forgetHashKey = nextHashKey;
	if (jobs !== undefined) {
		// `true` keeps a configured store, so a repeated call never discards
		// the open jobs it holds.
		_forgetJobs = jobs === true ? (_forgetJobs ?? createForgetJobStore()) : (jobs || null);
	}
	if (timeoutMs !== undefined) _forgetTimeoutMs = timeoutMs;
	if (resumeIntervalMs !== undefined) _resumeIntervalMs = resumeIntervalMs;
	_armResumeTimer();
}

/**
 * How often to run `resumeForgetJobs()` by itself, or null (the default).
 * @type {number | null}
 */
let _resumeIntervalMs = null;

/** Run `resumeForgetJobs()` on the configured interval while a job store is set. */
function _armResumeTimer() {
	if (_resumeTimer !== null) clearIntervalTimer(_resumeTimer);
	_resumeTimer = null;
	if (_resumeIntervalMs === null || _forgetJobs === null) return;
	_resumeTimer = setIntervalTimer(() => {
		resumeForgetJobs().catch(() => { /* A store outage is retried on the next tick. */ });
	}, _resumeIntervalMs);
	if (_resumeTimer && typeof _resumeTimer.unref === 'function') _resumeTimer.unref();
}

/**
 * Stop the timers this module runs (in-memory retries, the resume interval).
 * Called on shutdown and module reloads; the next erasure or configuration
 * arms them again.
 * @internal
 */
export function _stopForgetTimers() {
	if (_localTimer !== null) clearTimer(_localTimer);
	_localTimer = null;
	if (_resumeTimer !== null) clearIntervalTimer(_resumeTimer);
	_resumeTimer = null;
}
/**
 * Stable pseudonymous audit fingerprint. Without a key this keeps the original
 * enumerable idempotency fingerprint; HMAC prevents candidate matching without
 * the key. Either mode remains linkable and uses the same 32-hex record shape.
 * @param {string} userId
 * @param {import('node:crypto').KeyObject | null} key
 * @returns {string}
 */
function _hashUserId(userId, key) {
	return (key === null ? createHash('sha256') : createHmac('sha256', key))
		.update(userId).digest('hex').slice(0, 32);
}

/**
 * The in-memory purge surface: one auditable descriptor per user-keyed store the
 * framework holds in process. Each `run(tenantId, userId, cascade)` returns the
 * count it removed (sync or async). Adding a new user-keyed in-memory store
 * without a descriptor here trips the completeness test. Durable stores are NOT
 * listed here - they ride the `store.purgeUser` seam.
 * @type {Array<{ name: string, run: (tenantId: string | null, userId: string, cascade: any) => number | Promise<number> }>}
 */
const _descriptors = [
	{ name: 'push', run: (t, u) => _purgePushUser(t, u) },
	{ name: 'presence', run: (t, u) => _purgePresenceUser(_forgetPlatform, t, u, null) },
	{ name: 'rateLimit', run: (t, u) => _purgeRateLimitUser(t, u) },
	{ name: 'idempotency', run: (t, u) => _purgeIdempotencyUser(_tenantKey(t, u)) },
	// Smooth/game state: the subscriber registry (identity -> ws, whose RTT
	// tracker - a measured-latency fingerprint - rides the same entry),
	// cross-instance surrogates, interest state (reported center = a literal
	// user location, LOD memory, send cadence), and the lag-comp movement
	// ring when the entity key is the identity.
	{ name: 'smooth', run: (t, u) => _purgeSmoothUser(t, u) },
	// The webhook dead-letter queue retains full event payloads on delivery
	// exhaustion. Purge rides the store's own purgeUser (the in-memory store
	// stamps a capture-time userId via its forgetUserId extractor; the durable
	// stores implement the same contract). An enabled store must provide its
	// erasure method; records without attribution remain the app's responsibility.
	{ name: 'webhookDeadLetter', run: (t, u) => {
		const dl = state.webhookDeadLetter;
		if (!dl) return 0;
		if (typeof dl.purgeUser !== 'function') throw new Error('Dead-letter store has no purgeUser method');
		return dl.purgeUser(t, u);
	} },
	// Aggregate reducer state is arbitrary: an explicit reset policy must
	// discard every holder, or this surface reports incomplete erasure.
	{ name: 'aggregateCohorts', run: (_t, u) => _purgeAggregateCohorts(u, _forgetPlatform || undefined) }
];

/**
 * The descriptor names, for the completeness test (a known user-keyed store
 * must appear here).
 * @internal
 * @returns {string[]}
 */
export function _forgetSurfaceNames() {
	return _descriptors.map((d) => d.name);
}

/**
 * @typedef {Object} ForgetResult
 * @property {true} ok - Always true on a completed cascade (a constant-shape
 *   field so the result cannot be turned into an existence oracle by callers who
 *   re-expose it to clients).
 * @property {number} at - Wall-clock ms the cascade resolved.
 * @property {number} rowsAffected - Total entries/rows removed across every
 *   surface + the durable store. Zero when the user had no data. Returned to the
 *   trusted server caller; if you re-expose forget to untrusted clients, map the
 *   result to a constant shape so 0-vs-N does not reveal user existence.
 * @property {Record<string, number>} surfaces - Per-surface removal counts
 *   (in-memory descriptors + `durable`).
 * @property {string} [job] - The erasure job reference, with a job store only.
 */

/**
 * Publish the `:owner` successions a durable store reported from its cluster-wide
 * owner eviction. Each is a wire `:owner` `set` for the room's successor (or a
 * `vacated` null), routed through the same replay path a room succession uses so
 * live subscribers update and a resuming client gap-fills the successor. Runs on
 * the forgetting instance; a malformed entry is skipped. Without a configured
 * erasure platform it publishes through the platform the server captured at
 * startup (`realtime().init`, `setCronPlatform`, `_activateDerived`), the same
 * fallback the aggregate leg uses. The store has already committed, so a retry
 * cannot re-announce: when no platform exists at all, the unannounced count is
 * reported as an operational event instead of being dropped silently.
 * The `onOwnerChange` SERVER hook is deliberately NOT fired here - it is bound to
 * a room's local join state (its `_ownerRooms` entry), which the forgetting
 * instance need not hold (a remote-only room, a dedicated erasure runner), so only
 * the cluster-safe wire announcement is emitted; the hook still fires for a
 * locally-resolved succession on the instance that holds the room.
 * @param {string | null} tenantId
 * @param {any[]} successions
 * @returns {number} well-formed entries announced (each publish is best-effort:
 *   a throwing platform swallows inside `_ownerEmit` and still counts)
 */
function _publishOwnerSuccessions(tenantId, successions) {
	const publish = _ownerReplayPublisher(_forgetPlatform || state.cronPlatform || state.derivedPlatform);
	if (!publish) {
		if (successions.length) _reportUnannounced(successions.length);
		return 0;
	}
	let n = 0;
	for (const s of successions) {
		if (!s || typeof s.topic !== 'string' || s.topic.length === 0) continue;
		const owner = typeof s.owner === 'string' ? s.owner : null;
		const reason = typeof s.reason === 'string' ? s.reason : 'succeeded';
		_ownerEmit(s.topic, tenantId, { owner, previous: null, reason, _hook: null }, publish);
		n++;
	}
	return n;
}

/** @param {number} count */
function _reportUnannounced(count) {
	try {
		emitOperationalEvent({
			source: 'svelte-realtime', component: 'server.forget', event: 'forget.owner-succession-unannounced',
			severity: 'warn', dataClass: 'operational',
			message: 'The erasure store reported room owner changes but no platform is available to publish them; configure configureForget({ platform }) or initialize the server before erasing.',
			attributes: { count }
		});
	} catch { /* Diagnostic failures must not interrupt the erasure. */ }
}

/** @param {string[]} failedSurfaces @param {number} rowsAffected @param {string | null} job */
function _reportIncomplete(failedSurfaces, rowsAffected, job) {
	try {
		emitOperationalEvent({
			source: 'svelte-realtime', component: 'server.forget', event: 'forget.incomplete',
			severity: 'error', dataClass: 'operational',
			message: 'Erasure could not be confirmed for every configured surface; resolve the failed cleanup and retry.',
			attributes: job === null
				? { failedSurfaces: [...failedSurfaces], rowsAffected }
				: { failedSurfaces: [...failedSurfaces], rowsAffected, job }
		});
	} catch { /* Diagnostic failures must not interrupt the remaining cleanup. */ }
}

/** @param {string} job @param {string} code @param {number} attempts */
function _reportJobExhausted(job, code, attempts) {
	try {
		emitOperationalEvent({
			source: 'svelte-realtime', component: 'server.forget', event: 'forget.job-exhausted',
			severity: 'error', dataClass: 'operational',
			message: 'An erasure job failed on every attempt and no longer runs by itself; fix the cause and resume it by id, or abandon it.',
			attributes: { job, code, attempts }
		});
	} catch { /* Diagnostic failures must not change the erasure outcome. */ }
}

/** @param {string} job @param {'completed' | 'failed'} outcome */
function _reportJobUnrecorded(job, outcome) {
	try {
		emitOperationalEvent({
			source: 'svelte-realtime', component: 'server.forget', event: 'forget.job-unrecorded',
			severity: 'warn', dataClass: 'operational',
			message: 'The erasure job store could not record an erasure outcome; the job stays unfinished until resumeForgetJobs runs it again.',
			attributes: { job, outcome }
		});
	} catch { /* Diagnostic failures must not change the erasure outcome. */ }
}

/**
 * What is wrong with a cascade option, or null when it is valid: a boolean, or
 * an object whose optional `crdt` is an array of non-empty document names.
 * @param {unknown} cascade
 * @returns {'crdt' | 'shape' | null}
 */
function _cascadeProblem(cascade) {
	if (typeof cascade === 'boolean') return null;
	if (cascade === null || typeof cascade !== 'object') return 'shape';
	const crdt = /** @type {any} */ (cascade).crdt;
	if (crdt !== undefined && (!Array.isArray(crdt) || crdt.some((n) => typeof n !== 'string' || n.length === 0))) return 'crdt';
	return null;
}

/**
 * Attach the job reference to an erasure error for the server caller. It is
 * not enumerable and not in `details`, so an error rethrown to a client or
 * serialized into a response does not carry it.
 * @param {any} err @param {string | null} jobId
 */
function _withJob(err, jobId) {
	if (jobId !== null && err !== null && typeof err === 'object' && !Object.prototype.hasOwnProperty.call(err, 'job')) {
		Object.defineProperty(err, 'job', { value: jobId, enumerable: false, configurable: true });
	}
	return err;
}

const _liveForget = async function forget(userId, opts) {
	if (typeof userId !== 'string' || userId.length === 0) {
		throw new LiveError('INVALID_REQUEST', 'live.forget(userId) requires a non-empty userId string');
	}
	const reason = _validIdReason(userId, 'userId');
	if (reason !== null) {
		throw new LiveError('INVALID_REQUEST', 'live.forget: ' + reason + ' (max ' + _MAX_USER_ID_LENGTH + ' chars)');
	}
	const o = opts || {};
	if (typeof o !== 'object') {
		throw new LiveError('INVALID_REQUEST', 'live.forget(userId, opts): opts must be an object');
	}
	// tenantId is server-trusted: the app passes it from its own context
	// (ctx.tenantId or its own logic), NEVER straight off the wire. Validated to
	// the delimiter-safe charset so it cannot smuggle a `\0` into a scan match.
	// With a tenant resolver or qualified erasure store, every call names its scope: a
	// missing tenantId would otherwise fold into the untenanted scope and erase
	// nothing of the tenant's data while reporting success. An explicit null
	// still selects the untenanted scope. Both configured erasure stores take
	// tenantId as their first purgeUser argument, even without a local resolver.
	// With neither a store nor a resolver the legacy option stays optional.
	if (o.tenantId === undefined && (_isTenancyEnabled() || _forgetStore !== null || _forgetJobs !== null || state.webhookDeadLetter !== null)) {
		throw new LiveError('INVALID_REQUEST', 'live.forget: opts.tenantId is required when a tenant resolver or erasure store is configured (pass null for the untenanted scope)');
	}
	const tenantId = o.tenantId == null ? null : _validTenantId(o.tenantId);
	// cascade: `true` (default) runs the standard purge surface; the object
	// form extends it - `{ crdt: [...] }` names whole documents to drop (a
	// forgotten user's CRDT edits are merged with no per-user attribution, so
	// the whole-document drop is the only true erasure; only the app knows
	// which documents the user contributed to). The value is also threaded to
	// every descriptor and the durable store unchanged.
	const cascade = o.cascade === undefined ? true : o.cascade;
	const cascadeProblem = _cascadeProblem(cascade);
	if (cascadeProblem === 'crdt') {
		throw new LiveError('INVALID_REQUEST', 'live.forget: cascade.crdt must be an array of non-empty document topic names');
	}
	if (cascadeProblem === 'shape') {
		throw new LiveError('INVALID_REQUEST', 'live.forget: cascade must be a boolean or an object ({ crdt?: string[] })');
	}
	const onForget = o.onForget;
	if (onForget !== undefined && typeof onForget !== 'function') {
		throw new LiveError('INVALID_REQUEST', 'live.forget: onForget must be a function');
	}
	let hashKey = _forgetHashKey;
	if (o.hashKey !== undefined) {
		try { hashKey = _readHashKey(o.hashKey); }
		catch { throw new LiveError('INVALID_REQUEST', 'live.forget: hashKey must be a string or Uint8Array containing at least 32 bytes, or null'); }
	}
	// Capture before any purge or await; a concurrent key rotation cannot change
	// the audit identifier of an erasure that has already started.
	const jobs = _forgetJobs;
	const userIdHash = onForget || jobs !== null ? _hashUserId(userId, hashKey) : null;
	// Every call is its own job under a random reference: two workers erasing
	// the same user each record their own outcome, and the reference reveals
	// nothing about the user.
	const shared = jobs === null ? [] : _sharedSteps();
	const job = jobs === null ? null : {
		id: randomUuid(), runId: randomUuid(), attempts: 1, claimed: false, shared, local: _localSteps(cascade, shared)
	};
	return _runErasure(jobs, job, { userId, userIdHash, tenantId, cascade }, onForget);
};

/**
 * One erasure run with its job bookkeeping. With a job store, a new call
 * records the job before any surface is touched (a failure to record it erases
 * nothing); a resumed run has already claimed it. The run keeps its lease
 * alive while it works, does the job's open shared steps and, for a new call,
 * this process's in-memory steps, and records the shared outcome in the store.
 * In-memory steps left open stay with this process, which retries them itself.
 * @param {any} jobs
 * @param {{ id: string, runId: string, attempts: number, claimed: boolean, shared: string[], local: string[] } | null} job
 * @param {{ userId: string, userIdHash: string | null, tenantId: string | null, cascade: any }} run
 * @param {Function | undefined} onForget
 * @returns {Promise<ForgetResult>}
 */
async function _runErasure(jobs, job, run, onForget) {
	const { userId, userIdHash, tenantId, cascade } = run;
	const jobId = job === null ? null : job.id;
	// Participate in graceful drain so a shutdown waits for an in-progress
	// erasure rather than tearing it down half-applied (same contract as a cron
	// tick / an alarm fire). The `finally` drains exactly once on every exit.
	_enterInFlight();
	if (jobId !== null) _running.add(jobId);
	/** @type {(() => void) | null} */
	let stopRenewing = null;
	try {
		if (job !== null && !job.claimed) {
			try {
				await _bounded(jobs.begin({
					id: job.id, runId: job.runId, leaseMs: _LEASE_MS,
					userIdHash, tenantId, userId, cascade, shared: job.shared
				}), {
					// The caller is told nothing was erased; a record that lands
					// after that is abandoned, not run later.
					resolved: () => { void _abandonRefused(jobs, job.id); },
					rejected: () => { void _abandonRefused(jobs, job.id); }
				});
			} catch {
				// A rejection can still hide a committed record (a lost reply).
				_refuse(jobs, job.id, job.runId);
				throw _withJob(new LiveError('FORGET_JOB_FAILED', 'live.forget: the erasure job could not be recorded; nothing was erased'), jobId);
			}
		}
		if (job !== null) stopRenewing = _keepLease(jobs, job.id, job.runId);
		/** @type {{ failedSurfaces: string[], doneSurfaces: string[], rowsAffected: number }} */
		const failure = { failedSurfaces: [], doneSurfaces: [], rowsAffected: 0 };
		/** @type {Set<string> | null} */
		let plan = null;
		if (job !== null) {
			plan = new Set(job.local);
			for (const step of job.shared) {
				// A shared step whose store is no longer configured cannot be done here.
				if (_sharedStoreMissing(step)) failure.failedSurfaces.push(step);
				else plan.add(step);
			}
		}
		/** @type {{ surfaces: Record<string, number>, rowsAffected: number } | null} */
		let erased = null;
		/** @type {any} */
		let error = null;
		try {
			erased = await _erase(userId, tenantId, cascade, jobId, failure, plan);
		} catch (err) {
			error = err;
		}
		if (job !== null) {
			stopRenewing?.();
			stopRenewing = null;
			const done = new Set(failure.doneSurfaces);
			// In-memory steps this run left open stay with this process.
			const localOpen = job.local.filter((step) => !done.has(step));
			if (localOpen.length > 0) _keepLocal(job.id, { userId, userIdHash, tenantId, cascade }, localOpen);
			const sharedOpen = job.shared.filter((step) => !done.has(step));
			if (sharedOpen.length > 0) {
				const code = sharedOpen.includes('durable') ? 'FORGET_STORE_FAILED' : 'FORGET_INCOMPLETE';
				const exhausted = job.attempts >= _MAX_ATTEMPTS;
				const recorded = await _recordOutcome(jobs, 'fail', {
					id: job.id, runId: job.runId, code, failedSurfaces: sharedOpen,
					sharedDone: job.shared.filter((step) => done.has(step)),
					rowsAffected: failure.rowsAffected, retryAfterMs: _retryDelay(job.attempts), exhausted
				});
				if (recorded && exhausted) _reportJobExhausted(job.id, code, job.attempts);
			} else {
				await _recordOutcome(jobs, 'complete', { id: job.id, runId: job.runId, rowsAffected: failure.rowsAffected });
			}
		}
		if (error !== null) throw _withJob(error, jobId);
		const { surfaces, rowsAffected } = /** @type {{ surfaces: Record<string, number>, rowsAffected: number }} */ (erased);
		const at = wallEpoch();

		// Optional erasure hook: receives a stable pseudonymous hash of the
		// userId, the tenant, the cascade flag, and the counts.
		// Caught-and-recorded: a throwing hook never aborts a completed erasure.
		if (onForget) {
			try {
				// Shallow-copy surfaces so a hook that mutates the record cannot
				// alter the value returned to the caller (the same object).
				onForget({ userIdHash, tenantId, cascade, rowsAffected, surfaces: { ...surfaces }, at });
			} catch (err) {
				if (_IS_DEV) console.error('[svelte-realtime] live.forget onForget hook threw (erasure already completed):', err);
			}
		}

		return jobId === null ? { ok: true, at, rowsAffected, surfaces } : { ok: true, at, rowsAffected, surfaces, job: jobId };
	} finally {
		stopRenewing?.();
		if (jobId !== null) _running.delete(jobId);
		_exitInFlight();
	}
}

/**
 * Renew a run's lease every `_RENEW_MS` while it works. A run older than
 * `_MAX_RUN_MS` stops renewing and is reported, so its lease expires and
 * another run can take the job. Returns the stop function.
 * @param {any} jobs @param {string} id @param {string} runId
 * @returns {() => void}
 */
function _keepLease(jobs, id, runId) {
	const started = wallEpoch();
	let stopped = false;
	const timer = setIntervalTimer(() => {
		if (stopped) return;
		if (wallEpoch() - started >= _MAX_RUN_MS) {
			stop();
			_reportRunOverdue(id);
			return;
		}
		Promise.resolve()
			.then(() => _bounded(jobs.renew({ id, runId, leaseMs: _LEASE_MS })))
			.then((held) => { if (held === false) stop(); })
			.catch(() => { /* The next tick tries again; an expired lease only lets another run take over. */ });
	}, _RENEW_MS);
	if (timer && typeof timer.unref === 'function') timer.unref();
	function stop() {
		stopped = true;
		clearIntervalTimer(timer);
	}
	return stop;
}

/**
 * Record a run's outcome. A store that throws, or answers false because the
 * run no longer holds the lease, leaves the job open; that is reported, never
 * thrown, so the caller still gets the erasure's own result.
 * @param {any} jobs @param {'complete' | 'fail'} method @param {any} outcome
 * @returns {Promise<boolean>} whether the store recorded it
 */
async function _recordOutcome(jobs, method, outcome) {
	let recorded;
	try {
		recorded = await _bounded(jobs[method](outcome));
	} catch {
		recorded = false;
	}
	if (recorded === false) _reportJobUnrecorded(outcome.id, method === 'complete' ? 'completed' : 'failed');
	return recorded !== false;
}

/**
 * Remember a refused job whose record may have landed, and try to abandon it.
 * @param {any} jobs @param {string} id @param {string} runId
 */
function _refuse(jobs, id, runId) {
	if (!_refused.has(id) && _refused.size >= _MAX_REFUSED) {
		const oldest = _refused.keys().next().value;
		if (oldest !== undefined) _refused.delete(oldest);
	}
	if (!_refused.has(id)) _refused.set(id, { runId, tries: 0 });
	void _abandonRefused(jobs, id);
}

/**
 * Abandon a refused job's record, if it exists. Gives up after a few tries:
 * a record that never landed has nothing to abandon.
 * @param {any} jobs @param {string} id
 */
async function _abandonRefused(jobs, id) {
	const entry = _refused.get(id);
	if (entry === undefined) return;
	entry.tries++;
	try {
		if ((await _bounded(jobs.abandon({ id, runId: entry.runId }))) === true) { _refused.delete(id); return; }
	} catch { /* Counted as a try. */ }
	if (entry.tries >= _REFUSED_TRIES) _refused.delete(id);
}

/**
 * How long a failed job waits before it is due again: doubling from one second
 * per attempt, at most an hour, so a job that keeps failing yields to others.
 * @param {number} attempts
 */
function _retryDelay(attempts) {
	const n = Number.isSafeInteger(attempts) && attempts > 0 ? attempts : 1;
	return Math.min(_RETRY_BASE_MS * 2 ** Math.min(n - 1, 30), _RETRY_MAX_MS);
}

/**
 * Keep in-memory steps this process still owes for a job, and arm the retry.
 * @param {string} id
 * @param {{ userId: string, userIdHash: string | null, tenantId: string | null, cascade: any }} run
 * @param {string[]} open
 */
function _keepLocal(id, run, open) {
	const entry = _localJobs.get(id);
	if (entry !== undefined) {
		entry.open = new Set(open);
		return;
	}
	if (_localJobs.size >= _MAX_LOCAL_JOBS) {
		const oldest = _localJobs.keys().next().value;
		if (oldest !== undefined) {
			_localJobs.delete(oldest);
			_reportLocal('forget.local-dropped', oldest, 0);
		}
	}
	_localJobs.set(id, {
		userId: run.userId, userIdHash: run.userIdHash, tenantId: run.tenantId, cascade: run.cascade,
		open: new Set(open), attempts: 1, retryAt: wallEpoch() + _retryDelay(1), exhausted: false
	});
	_armLocalTimer();
}

/** Arm one timer for the earliest in-memory retry this process owes. */
function _armLocalTimer() {
	if (_localTimer !== null) clearTimer(_localTimer);
	_localTimer = null;
	let next = Infinity;
	for (const entry of _localJobs.values()) if (!entry.exhausted && entry.retryAt < next) next = entry.retryAt;
	if (next === Infinity) return;
	_localTimer = setTimer(() => {
		_localTimer = null;
		_retryLocalDue().catch(() => { /* Each retry reports its own failure. */ });
	}, Math.max(0, next - wallEpoch()));
	if (_localTimer && typeof _localTimer.unref === 'function') _localTimer.unref();
}

/**
 * Retry the in-memory steps this process owes whose time has come, or only
 * job `id` whatever its time. Resolves one result per job tried.
 * @param {string} [id]
 * @returns {Promise<Array<{ id: string, status: 'completed' | 'failed' | 'skipped', code?: string }>>}
 */
async function _retryLocalDue(id) {
	/** @type {Array<{ id: string, status: 'completed' | 'failed' | 'skipped', code?: string }>} */
	const results = [];
	const now = wallEpoch();
	const ids = id !== undefined ? (_localJobs.has(id) ? [id] : []) : [..._localJobs].filter(([, e]) => !e.exhausted && e.retryAt <= now).map(([k]) => k);
	for (const jobId of ids) {
		const entry = _localJobs.get(jobId);
		if (entry === undefined || _running.has(jobId)) {
			results.push({ id: jobId, status: 'skipped' });
			continue;
		}
		_running.add(jobId);
		_enterInFlight();
		try {
			/** @type {{ failedSurfaces: string[], doneSurfaces: string[], rowsAffected: number }} */
			const failure = { failedSurfaces: [], doneSurfaces: [], rowsAffected: 0 };
			let code = null;
			try {
				await _erase(entry.userId, entry.tenantId, entry.cascade, jobId, failure, new Set(entry.open));
			} catch (err) {
				code = String(/** @type {any} */ (err)?.code || 'INTERNAL_ERROR');
			}
			for (const step of failure.doneSurfaces) entry.open.delete(step);
			if (entry.open.size === 0) {
				_localJobs.delete(jobId);
				results.push({ id: jobId, status: 'completed' });
			} else {
				entry.attempts++;
				entry.retryAt = wallEpoch() + _retryDelay(entry.attempts);
				if (entry.attempts >= _MAX_ATTEMPTS && !entry.exhausted) {
					entry.exhausted = true;
					_reportLocal('forget.local-exhausted', jobId, entry.attempts);
				}
				results.push({ id: jobId, status: 'failed', code: code ?? 'FORGET_INCOMPLETE' });
			}
		} finally {
			_running.delete(jobId);
			_exitInFlight();
		}
	}
	_armLocalTimer();
	return results;
}

/**
 * @param {'forget.local-exhausted' | 'forget.local-dropped'} event
 * @param {string} job @param {number} attempts
 */
function _reportLocal(event, job, attempts) {
	try {
		emitOperationalEvent(event === 'forget.local-exhausted'
			? {
				source: 'svelte-realtime', component: 'server.forget', event: 'forget.local-exhausted',
				severity: 'error', dataClass: 'operational',
				message: 'In-memory erasure steps failed on every retry in this process and are no longer retried by themselves.',
				attributes: { job, attempts }
			}
			: {
				source: 'svelte-realtime', component: 'server.forget', event: 'forget.local-dropped',
				severity: 'error', dataClass: 'operational',
				message: 'This process dropped the open in-memory erasure steps of its oldest job to track a new erasure.',
				attributes: { job }
			});
	} catch { /* Diagnostic failures must not change the erasure outcome. */ }
}

/**
 * Report a run that passed the longest a run may hold a job.
 * @param {string} job
 */
function _reportRunOverdue(job) {
	try {
		emitOperationalEvent({
			source: 'svelte-realtime', component: 'server.forget', event: 'forget.run-overdue',
			severity: 'error', dataClass: 'operational',
			message: 'An erasure run is still going after the longest a run may hold its job; its lease is no longer renewed, so another run can take the job.',
			attributes: { job }
		});
	} catch { /* Diagnostic failures must not change the erasure outcome. */ }
}

/**
 * The cascade itself: every in-memory surface, named documents, then the
 * durable store; with a `plan`, only the steps it names. Resolves the counts
 * or throws the erasure's LiveError; either way `failure` holds the names of
 * the surfaces that failed and of those that finished, and the rows removed.
 * @param {string} userId @param {string | null} tenantId @param {any} cascade
 * @param {string | null} jobId
 * @param {{ failedSurfaces: string[], doneSurfaces: string[], rowsAffected: number }} failure
 * @param {ReadonlySet<string> | null} plan
 * @returns {Promise<{ surfaces: Record<string, number>, rowsAffected: number }>}
 */
async function _erase(userId, tenantId, cascade, jobId, failure, plan) {
	const crdtDocs = cascade !== null && typeof cascade === 'object' && Array.isArray(cascade.crdt) ? cascade.crdt : null;
	/** @type {Record<string, number>} */
	const surfaces = {};
	const { failedSurfaces, doneSurfaces } = failure;
	let rowsAffected = 0;

	// In-memory descriptors run sequentially: the surface is small, the work
	// is local, and a deterministic order keeps the cascade auditable.
	for (const d of _descriptors) {
		if (plan !== null && !plan.has(d.name)) continue;
		let count = 0;
		try {
			count = await _bounded(d.run(tenantId, userId, cascade));
			if (!Number.isSafeInteger(count) || count < 0) throw new Error('Purge method did not confirm a valid removal count');
			doneSurfaces.push(d.name);
		} catch {
			// Attempt every independent surface before reporting incomplete work.
			failedSurfaces.push(d.name);
			count = 0;
		}
		const n = typeof count === 'number' && count > 0 ? count : 0;
		surfaces[d.name] = n;
		rowsAffected += n;
	}

	// Whole-document CRDT drops (cascade.crdt): erase the named documents'
	// loaded replicas. Deleting the durably persisted copies is the app's
	// half, in its own persist store.
	if (crdtDocs !== null && (plan === null || plan.has('crdtDocs'))) {
		let dropped = 0;
		try {
			dropped = _purgeCrdtDocs(crdtDocs);
			doneSurfaces.push('crdtDocs');
		} catch {
			failedSurfaces.push('crdtDocs');
		}
		surfaces.crdtDocs = dropped;
		rowsAffected += dropped;
	}

	// Durable store: erase the user's cluster rows and WAIT for confirmation -
	// resolving before the durable delete confirms would be a compliance lie
	// (GDPR must wait for durable confirmation). The return shapes are handled
	// below (count, breakdown, or the owner-succession envelope).
	if (_forgetStore && (plan === null || plan.has('durable'))) {
		let successions = null;
		try {
			// A purge that commits after its timeout still announces the owner
			// changes it made: a retry finds those rooms already handed over and
			// reports nothing for them, so this is their only announcement.
			const durable = await _bounded(_forgetStore.purgeUser(tenantId, userId, cascade), {
				resolved: (v) => {
					if (v && typeof v === 'object' && Array.isArray(/** @type {any} */ (v).ownerSuccessions)) _publishOwnerSuccessions(tenantId, /** @type {any} */ (v).ownerSuccessions);
				},
				rejected: (e) => {
					if (e && Array.isArray(/** @type {any} */ (e).ownerSuccessions)) _publishOwnerSuccessions(tenantId, /** @type {any} */ (e).ownerSuccessions);
				}
			});
			// The store may return a total (number), a per-store count
			// breakdown (object), or the owner-succession envelope
			// `{ rowsAffected?, ownerSuccessions? }` - detected by an
			// `ownerSuccessions` array (a plain count breakdown never carries
			// one). Split the counts from the successions; the counts fold as
			// before, the successions publish `:owner` for the rooms the store
			// evicted the user from as owner cluster-wide.
			let counts = durable;
			if (durable && typeof durable === 'object' && Array.isArray(/** @type {any} */ (durable).ownerSuccessions)) {
				successions = /** @type {any} */ (durable).ownerSuccessions;
				counts = /** @type {any} */ (durable).rowsAffected;
			}
			if (typeof counts === 'number') {
				surfaces.durable = counts > 0 ? counts : 0;
				rowsAffected += surfaces.durable;
			} else if (counts && typeof counts === 'object') {
				let sum = 0;
				for (const v of Object.values(counts)) {
					const n = typeof v === 'number' && v > 0 ? v : 0;
					sum += n;
				}
				surfaces.durable = sum;
				rowsAffected += sum;
			} else {
				surfaces.durable = 0;
			}
		} catch (err) {
			// Keep failure metadata bounded and omit store exceptions, which can
			// include erased or successor identities and payloads.
			failedSurfaces.push('durable');
			_reportIncomplete(failedSurfaces, rowsAffected, jobId);
			// The store may have COMMITTED some owner successions before a
			// sibling room's transient failure aborted the leg: those evictions
			// are durable and authoritative, so announce them now even though the
			// overall erasure is incomplete and will be retried. The retry
			// re-drives only the failed rooms (a committed room reads o != userId
			// and reports nothing), so each committed succession reaches the
			// `:owner` wire exactly once. Best-effort and fully guarded: a throw
			// here must never mask FORGET_STORE_FAILED (which would tell the caller
			// the partially-failed erasure need not be retried).
			const committed = err && Array.isArray(/** @type {any} */ (err).ownerSuccessions)
				? /** @type {any} */ (err).ownerSuccessions
				: null;
			if (committed && committed.length) {
				try {
					_publishOwnerSuccessions(tenantId, committed);
				} catch (pubErr) {
					if (_IS_DEV) console.error('[svelte-realtime] live.forget announce-on-failure threw:', pubErr);
				}
			}
			failure.rowsAffected = rowsAffected;
			throw new LiveError('FORGET_STORE_FAILED', 'live.forget: durable store.purgeUser failed; the erasure is incomplete and must be retried');
		}
		// Publish the store's owner successions AFTER the durable try/catch:
		// the authoritative eviction already committed in the store, so the
		// wire announcement is best-effort by construction and an exotic throw
		// out of it must never misreport as FORGET_STORE_FAILED (which would
		// tell the caller to retry an erasure that succeeded).
		doneSurfaces.push('durable');
		if (successions !== null) {
			surfaces.ownerSuccessions = _publishOwnerSuccessions(tenantId, successions);
		}
	}

	failure.rowsAffected = rowsAffected;
	if (failedSurfaces.length) {
		_reportIncomplete(failedSurfaces, rowsAffected, jobId);
		throw new LiveError('FORGET_INCOMPLETE', 'Erasure is incomplete; resolve failed cleanup surfaces and retry');
	}

	return { surfaces, rowsAffected };
}

/**
 * Attach `live.forget` onto the live object. Mirrors `installPush(live)`.
 * @param {any} live
 */
export function installForget(live) {
	live.forget = _liveForget;
}

/**
 * Reset forget configuration, including the audit key.
 * @internal
 */
export function _resetForget() {
	_clearForgetConfig();
	// Tests use this to stand for a new process: no memory of earlier runs.
	_localJobs.clear();
	_refused.clear();
}

/** Clear every forget setting and stop the timers. */
function _clearForgetConfig() {
	_forgetStore = null;
	_forgetPlatform = null;
	_forgetHashKey = null;
	_forgetJobs = null;
	_forgetTimeoutMs = null;
	_resumeIntervalMs = null;
	_stopForgetTimers();
}

/** @param {string} message */
function _invalidJobRequest(message) {
	return new LiveError('INVALID_REQUEST', message);
}

/** @param {unknown} limit @param {string} name */
function _jobLimit(limit, name) {
	if (limit === undefined) return 100;
	if (!Number.isInteger(limit) || /** @type {number} */ (limit) < 1 || /** @type {number} */ (limit) > _MAX_JOB_LIMIT) {
		throw _invalidJobRequest(name + ': limit must be an integer from 1 to ' + _MAX_JOB_LIMIT);
	}
	return /** @type {number} */ (limit);
}

/** @param {unknown} id @param {string} name */
function _jobId(id, name) {
	if (typeof id !== 'string' || id.length === 0 || id.length > 256) {
		throw _invalidJobRequest(name + ': id must be a non-empty string of at most 256 characters');
	}
	return id;
}

/**
 * This process's open in-memory steps for a job, as listings show them.
 * @param {string} id
 */
function _localView(id) {
	const entry = _localJobs.get(id);
	if (entry === undefined) return null;
	return { open: [...entry.open], attempts: entry.attempts, retryAt: entry.exhausted ? null : entry.retryAt, exhausted: entry.exhausted };
}

/**
 * The public view of a stored job: a fixed set of fields, so a store that
 * keeps more (the raw user id of an open job) never leaks it here, plus this
 * process's open in-memory steps for it.
 * @param {any} j
 */
function _publicJob(j) {
	const error = j && j.error && typeof j.error === 'object'
		? { code: String(j.error.code), failedSurfaces: Array.isArray(j.error.failedSurfaces) ? j.error.failedSurfaces.map(String) : [] }
		: null;
	const id = String(j.id);
	return {
		id,
		userIdHash: typeof j.userIdHash === 'string' ? j.userIdHash : null,
		tenantId: typeof j.tenantId === 'string' ? j.tenantId : null,
		status: j.status,
		attempts: Number(j.attempts) || 0,
		createdAt: Number(j.createdAt),
		updatedAt: Number(j.updatedAt),
		completedAt: typeof j.completedAt === 'number' ? j.completedAt : null,
		retryAt: j.status === 'failed' && typeof j.retryAt === 'number' ? j.retryAt : null,
		rowsAffected: typeof j.rowsAffected === 'number' ? j.rowsAffected : 0,
		error,
		local: _localView(id)
	};
}

/**
 * List recorded erasure jobs, oldest first. Each carries the random job
 * reference and, while open, the audit hash - never the user id - and the
 * in-memory steps this process still owes for it. Empty without a job store.
 * @param {{ status?: 'pending' | 'failed' | 'exhausted' | 'completed' | 'abandoned', limit?: number }} [filter]
 */
export async function listForgetJobs(filter = {}) {
	if (filter === null || typeof filter !== 'object') throw _invalidJobRequest('listForgetJobs: filter must be an object');
	const { status } = filter;
	if (status !== undefined && !_JOB_STATUSES.includes(status)) {
		throw _invalidJobRequest('listForgetJobs: status must be one of ' + _JOB_STATUSES.join(', '));
	}
	const limit = _jobLimit(filter.limit, 'listForgetJobs');
	const jobs = _forgetJobs;
	if (jobs === null) return [];
	let rows;
	try {
		rows = await _bounded(jobs.list(status === undefined ? { limit } : { status, limit }));
	} catch {
		throw new LiveError('FORGET_JOB_FAILED', 'listForgetJobs: the erasure job store could not be read');
	}
	return (Array.isArray(rows) ? rows : []).slice(0, limit).map(_publicJob);
}

/**
 * Run open erasure work again. First the in-memory steps this process still
 * owes whose retry time has come (results with `steps: 'local'`), then the
 * jobs whose shared steps are due: failed ones past their `retryAt` and
 * pending ones whose run let its lease expire, earliest due first, at most
 * `limit` (default 100). With `id`, just that job - its in-memory steps here
 * and its shared steps - regardless of retry time; with `exhausted: true`,
 * the exhausted jobs and this process's exhausted in-memory steps. Each shared
 * run claims the job's lease first, so a job another live run holds is
 * skipped.
 * @param {{ id?: string, limit?: number, exhausted?: boolean, onForget?: Function }} [opts]
 */
export async function resumeForgetJobs(opts = {}) {
	if (opts === null || typeof opts !== 'object') throw _invalidJobRequest('resumeForgetJobs: options must be an object');
	const { id, onForget } = opts;
	if (id !== undefined) _jobId(id, 'resumeForgetJobs');
	const limit = _jobLimit(opts.limit, 'resumeForgetJobs');
	if (onForget !== undefined && typeof onForget !== 'function') {
		throw _invalidJobRequest('resumeForgetJobs: onForget must be a function');
	}
	if (opts.exhausted !== undefined && typeof opts.exhausted !== 'boolean') {
		throw _invalidJobRequest('resumeForgetJobs: exhausted must be a boolean');
	}
	const exhausted = opts.exhausted === true;
	/** @type {{ total: number, completed: number, failed: number, results: Array<{ id: string, steps: 'shared' | 'local', status: 'completed' | 'failed' | 'skipped', code?: string }> }} */
	const out = { total: 0, completed: 0, failed: 0, results: [] };
	const jobs = _forgetJobs;
	if (jobs === null) return out;

	// In-memory steps first: only this process can do them.
	let local;
	if (id !== undefined) local = await _retryLocalDue(id);
	else if (exhausted) {
		for (const entry of _localJobs.values()) if (entry.exhausted) { entry.exhausted = false; entry.retryAt = 0; }
		local = await _retryLocalDue();
	} else local = await _retryLocalDue();
	for (const r of local) {
		out.total++;
		if (r.status === 'completed') out.completed++;
		else if (r.status === 'failed') out.failed++;
		out.results.push({ ...r, steps: 'local' });
	}

	/** @type {string[]} */
	let ids;
	if (id !== undefined) {
		ids = [id];
	} else {
		try {
			const due = await _bounded(jobs.due(exhausted ? { limit, exhausted: true } : { limit }));
			ids = (Array.isArray(due) ? due : []).slice(0, limit).map((j) => String(j.id));
		} catch {
			throw new LiveError('FORGET_JOB_FAILED', 'resumeForgetJobs: the erasure job store could not be read');
		}
	}
	for (const jobId of ids) {
		// A job whose caller was refused is abandoned, never run, and a job a
		// run of this process is still working on is not started twice.
		if (_refused.has(jobId)) {
			await _abandonRefused(jobs, jobId);
			if (id === undefined) continue;
		}
		out.total++;
		if (_running.has(jobId) || _refused.has(jobId)) {
			out.results.push({ id: jobId, steps: 'shared', status: 'skipped' });
			continue;
		}
		const runId = randomUuid();
		let claim;
		try {
			claim = await _bounded(jobs.claim({ id: jobId, runId, leaseMs: _LEASE_MS, exhausted: exhausted || id !== undefined }));
		} catch {
			out.failed++;
			out.results.push({ id: jobId, steps: 'shared', status: 'failed', code: 'FORGET_JOB_FAILED' });
			continue;
		}
		if (!claim) {
			out.results.push({ id: jobId, steps: 'shared', status: 'skipped' });
			continue;
		}
		const shared = Array.isArray(claim.shared) ? claim.shared.filter((/** @type {unknown} */ n) => typeof n === 'string') : [];
		const job = { id: jobId, runId, attempts: Number(claim.attempts) || 1, claimed: true, shared, local: [] };
		let started = false;
		try {
			const { userId, tenantId, cascade } = claim;
			if (typeof userId !== 'string' || userId.length === 0 || _validIdReason(userId, 'userId') !== null) {
				throw _invalidJobRequest('resumeForgetJobs: the stored job has no valid user id');
			}
			const scope = tenantId == null ? null : _validTenantId(tenantId);
			// The stored cascade is replayed only in a shape live.forget accepts,
			// so a damaged record cannot run a different erasure than requested.
			const stored = cascade ?? true;
			if (_cascadeProblem(stored) !== null) {
				throw _invalidJobRequest('resumeForgetJobs: the stored job has an invalid cascade');
			}
			const userIdHash = typeof claim.userIdHash === 'string' ? claim.userIdHash : _hashUserId(userId, _forgetHashKey);
			started = true;
			await _runErasure(jobs, job, { userId, userIdHash, tenantId: scope, cascade: stored }, onForget);
			out.completed++;
			out.results.push({ id: jobId, steps: 'shared', status: 'completed' });
		} catch (err) {
			const code = String(/** @type {any} */ (err)?.code || 'INTERNAL_ERROR');
			// A stored job this run cannot even start still releases its lease
			// with a failure, so it stays listed and backs off like any other.
			if (!started) {
				const isExhausted = job.attempts >= _MAX_ATTEMPTS;
				const recorded = await _recordOutcome(jobs, 'fail', {
					id: jobId, runId, code, failedSurfaces: [], sharedDone: [], rowsAffected: 0,
					retryAfterMs: _retryDelay(job.attempts), exhausted: isExhausted
				});
				if (recorded && isExhausted) _reportJobExhausted(jobId, code, job.attempts);
			}
			out.failed++;
			out.results.push({ id: jobId, steps: 'shared', status: 'failed', code });
		}
	}
	return out;
}

/**
 * Give up an open erasure job: the store marks it `abandoned` and drops its
 * user id, and this process drops the in-memory steps it still owes for it.
 * A job a live run is working on is not abandoned. Resolves whether anything
 * was given up; false without a job store.
 * @param {string} id
 * @returns {Promise<boolean>}
 */
export async function abandonForgetJob(id) {
	_jobId(id, 'abandonForgetJob');
	const jobs = _forgetJobs;
	if (jobs === null || _running.has(id)) return false;
	const local = _localJobs.delete(id);
	if (local) _armLocalTimer();
	try {
		return (await _bounded(jobs.abandon({ id }))) === true || local;
	} catch {
		throw new LiveError('FORGET_JOB_FAILED', 'abandonForgetJob: the erasure job store could not be written');
	}
}
