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
 * `beat`, `begin`, `claim`, `complete`, `fail`, `list` and `due`, each sync or
 * async.
 * `createForgetJobStore()` is the in-memory reference; durable stores implement
 * the same methods. Set via `configureForget({ jobs })`.
 * @type {any}
 */
let _forgetJobs = null;

const _JOB_METHODS = ['beat', 'begin', 'claim', 'complete', 'fail', 'list', 'due'];

const _MAX_TIMEOUT_MS = 600_000;

// A process with a job store beats every `_BEAT_MS`; one whose last beat is
// older than `_PROCESS_TTL_MS` is gone, and its in-memory state with it.
const _BEAT_MS = 10_000;
const _PROCESS_TTL_MS = 30_000;

/** @type {string | null} */
let _processIdValue = null;
/** @type {any} */
let _beatTimer = null;

/** This process's identity in the job store, drawn once. */
function _processId() {
	if (_processIdValue === null) _processIdValue = randomUuid();
	return _processIdValue;
}

/** Jobs a run of this process is working on. */
const _running = new Set();

/**
 * In-memory steps this process finished for jobs it owns whose outcome the
 * store has not recorded yet, so a later run of the same job does not repeat
 * them (a document dropped then may hold new edits by now).
 * @type {Map<string, Set<string>>}
 */
const _localDone = new Map();

/** Beat now and every `_BEAT_MS` while a job store is configured. */
function _startBeat() {
	_stopBeat();
	const beat = () => {
		const jobs = _forgetJobs;
		if (jobs === null) return;
		const at = wallEpoch();
		Promise.resolve()
			.then(() => jobs.beat({ processId: _processId(), at, aliveUntil: at + _PROCESS_TTL_MS }))
			.catch(() => { /* A missed beat only shortens how long others see this process alive. */ });
	};
	beat();
	_beatTimer = setIntervalTimer(beat, _BEAT_MS);
	if (_beatTimer && typeof _beatTimer.unref === 'function') _beatTimer.unref();
}

function _stopBeat() {
	if (_beatTimer !== null) clearIntervalTimer(_beatTimer);
	_beatTimer = null;
}

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
const _JOB_STATUSES = ['pending', 'failed', 'completed'];
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
 * `timeoutMs` bounds each store call an erasure waits on.
 * Omitted settings are retained; `null` clears all of them.
 *
 * @param {{ store?: { purgeUser: Function } | null, platform?: any, hashKey?: string | Uint8Array | null, jobs?: boolean | object | null, timeoutMs?: number } | null} config
 */
export function configureForget(config) {
	if (config === null) { _clearForgetConfig(); return; }
	if (typeof config !== 'object') {
		throw new Error('[svelte-realtime] configureForget: config must be an object or null');
	}
	const { store, platform, hashKey, jobs, timeoutMs } = config;
	if (store === undefined && platform === undefined && hashKey === undefined && jobs === undefined && timeoutMs === undefined) {
		throw new Error('[svelte-realtime] configureForget: config must include at least one of store, platform, hashKey, jobs or timeoutMs');
	}
	if (timeoutMs !== undefined && timeoutMs !== null && (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > _MAX_TIMEOUT_MS)) {
		throw new Error('[svelte-realtime] configureForget: timeoutMs must be an integer from 1 to ' + _MAX_TIMEOUT_MS + ', or null');
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
		_forgetJobs = jobs === true ? createForgetJobStore() : (jobs || null);
		if (_forgetJobs === null) _stopBeat();
		else _startBeat();
	}
	if (timeoutMs !== undefined) _forgetTimeoutMs = timeoutMs;
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
		id: randomUuid(), runId: randomUuid(), attempts: 1, claimed: false,
		owner: true, ownerAlive: true, shared, local: _localSteps(cascade, shared)
	};
	return _runErasure(jobs, job, { userId, userIdHash, tenantId, cascade }, onForget);
};

/**
 * One erasure run with its job bookkeeping. With a job store, a new call
 * records the job, owned by this process, before any surface is touched (a
 * failure to record it erases nothing); a resumed run has already claimed it.
 * The run does the job's shared steps that are still open and, in the owning
 * process only, the owner's in-memory steps that are still open. The job
 * completes once no shared step is open and its owner has nothing left or is
 * gone; while a live owner still has in-memory steps, a run elsewhere records
 * its progress and leaves them to the owner (`run.waiting`).
 * @param {any} jobs
 * @param {{ id: string, runId: string, attempts: number, claimed: boolean, owner: boolean, ownerAlive: boolean, shared: string[], local: string[] } | null} job
 * @param {{ userId: string, userIdHash: string | null, tenantId: string | null, cascade: any, waiting?: boolean }} run
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
	try {
		if (job !== null && !job.claimed) {
			const at = wallEpoch();
			try {
				await _bounded(jobs.begin({
					id: job.id, runId: job.runId, processId: _processId(), aliveUntil: at + _PROCESS_TTL_MS,
					userIdHash, tenantId, userId, cascade, shared: job.shared, local: job.local, at
				}));
			} catch {
				throw _withJob(new LiveError('FORGET_JOB_FAILED', 'live.forget: the erasure job could not be recorded; nothing was erased'), jobId);
			}
		}
		/** @type {{ failedSurfaces: string[], doneSurfaces: string[], rowsAffected: number }} */
		const failure = { failedSurfaces: [], doneSurfaces: [], rowsAffected: 0 };
		/** @type {Set<string> | null} */
		let plan = null;
		/** @type {Set<string>} */
		let localDone = new Set();
		if (job !== null) {
			// In-memory steps this process finished for its own job are not run
			// again, even when the store never heard of them.
			localDone = job.owner ? new Set(_localDone.get(job.id)) : localDone;
			plan = new Set();
			for (const step of job.shared) {
				// A shared step whose store is no longer configured cannot be done here.
				if (_sharedStoreMissing(step)) failure.failedSurfaces.push(step);
				else plan.add(step);
			}
			if (job.owner) for (const step of job.local) if (!localDone.has(step)) plan.add(step);
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
		if (job === null) {
			if (error !== null) throw error;
		} else {
			const done = new Set(failure.doneSurfaces);
			const sharedDone = job.shared.filter((step) => done.has(step));
			if (job.owner) {
				for (const step of job.local) if (done.has(step)) localDone.add(step);
				_localDone.set(job.id, localDone);
			}
			const sharedOpen = job.shared.filter((step) => !done.has(step));
			const localOpen = job.owner ? job.local.filter((step) => !localDone.has(step)) : (job.ownerAlive ? job.local : []);
			const at = wallEpoch();
			if (error !== null || sharedOpen.length > 0 || localOpen.length > 0) {
				// Left for the owner when this run did its part and only a live
				// owner's in-memory steps remain: due again at once for it.
				const waiting = error === null;
				const recorded = await _recordOutcome(jobs, 'fail', {
					id: job.id, runId: job.runId, at,
					code: waiting ? 'FORGET_INCOMPLETE' : /** @type {any} */ (error)?.code || 'INTERNAL_ERROR',
					failedSurfaces: waiting ? localOpen : failure.failedSurfaces,
					sharedDone, localDone: job.owner ? [...localDone] : [],
					rowsAffected: failure.rowsAffected,
					retryAt: waiting ? at : at + _retryDelay(job.attempts)
				});
				if (recorded && job.owner) _localDone.delete(job.id);
				if (error !== null) throw _withJob(error, jobId);
				run.waiting = true;
			} else {
				await _recordOutcome(jobs, 'complete', { id: job.id, runId: job.runId, at, rowsAffected: failure.rowsAffected });
				_localDone.delete(job.id);
			}
			if (error === null && run.waiting) {
				const result = /** @type {{ surfaces: Record<string, number>, rowsAffected: number }} */ (erased);
				return { ok: true, at, rowsAffected: result.rowsAffected, surfaces: result.surfaces, job: job.id };
			}
		}
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
		if (jobId !== null) _running.delete(jobId);
		_exitInFlight();
	}
}

/**
 * Record a run's outcome. A store that throws, or answers false because the
 * run no longer holds the lease, leaves the job unfinished; that is reported,
 * never thrown, so the caller still gets the erasure's own result.
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
 * How long a failed job waits before it is due again: doubling from one second
 * per attempt, at most an hour, so a job that keeps failing yields to others.
 * @param {number} attempts
 */
function _retryDelay(attempts) {
	const n = Number.isSafeInteger(attempts) && attempts > 0 ? attempts : 1;
	return Math.min(_RETRY_BASE_MS * 2 ** Math.min(n - 1, 30), _RETRY_MAX_MS);
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
	// Tests use this to stand for a new process: a fresh identity and no memory
	// of earlier runs.
	_processIdValue = null;
	_localDone.clear();
}

/** Clear every forget setting and stop beating. */
function _clearForgetConfig() {
	_forgetStore = null;
	_forgetPlatform = null;
	_forgetHashKey = null;
	_forgetJobs = null;
	_forgetTimeoutMs = null;
	_stopBeat();
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

/**
 * The public view of a stored job: a fixed set of fields, so a store that
 * keeps more (the raw user id of an unfinished job) never leaks it here.
 * @param {any} j
 */
function _publicJob(j) {
	const error = j && j.error && typeof j.error === 'object'
		? { code: String(j.error.code), failedSurfaces: Array.isArray(j.error.failedSurfaces) ? j.error.failedSurfaces.map(String) : [] }
		: null;
	return {
		id: String(j.id),
		processId: typeof j.processId === 'string' ? j.processId : null,
		userIdHash: String(j.userIdHash),
		tenantId: typeof j.tenantId === 'string' ? j.tenantId : null,
		status: j.status,
		attempts: Number(j.attempts) || 0,
		createdAt: Number(j.createdAt),
		updatedAt: Number(j.updatedAt),
		completedAt: typeof j.completedAt === 'number' ? j.completedAt : null,
		retryAt: j.status === 'failed' && typeof j.retryAt === 'number' ? j.retryAt : null,
		rowsAffected: typeof j.rowsAffected === 'number' ? j.rowsAffected : 0,
		error
	};
}

/**
 * List recorded erasure jobs, oldest first. Each carries the pseudonymous job
 * reference and audit hash, never the user id. Empty without a job store.
 * @param {{ status?: 'pending' | 'failed' | 'completed', limit?: number }} [filter]
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
 * Run unfinished erasure jobs again: failed ones whose retry time has come,
 * and pending ones whose run ended without recording an outcome (a crash, a
 * store outage) once its lease expired. Longest due first, at most `limit`
 * (default 100) per call, or just the job named by `id`, which runs regardless
 * of its retry time. Each run first claims the job's lease, so a job another
 * run holds, in this process or another, is skipped. Each run is the full
 * idempotent cascade under the job's stored tenant and cascade options.
 * @param {{ id?: string, limit?: number, onForget?: Function }} [opts]
 */
export async function resumeForgetJobs(opts = {}) {
	if (opts === null || typeof opts !== 'object') throw _invalidJobRequest('resumeForgetJobs: options must be an object');
	const { id, onForget } = opts;
	if (id !== undefined && (typeof id !== 'string' || id.length === 0 || id.length > 256)) {
		throw _invalidJobRequest('resumeForgetJobs: id must be a non-empty string of at most 256 characters');
	}
	const limit = _jobLimit(opts.limit, 'resumeForgetJobs');
	if (onForget !== undefined && typeof onForget !== 'function') {
		throw _invalidJobRequest('resumeForgetJobs: onForget must be a function');
	}
	/** @type {{ total: number, completed: number, failed: number, results: Array<{ id: string, status: 'completed' | 'failed' | 'skipped' | 'waiting', code?: string }> }} */
	const out = { total: 0, completed: 0, failed: 0, results: [] };
	const jobs = _forgetJobs;
	if (jobs === null) return out;
	/** @type {string[]} */
	let ids;
	if (id !== undefined) {
		ids = [id];
	} else {
		try {
			const due = await _bounded(jobs.due({ at: wallEpoch(), limit, processId: _processId() }));
			ids = (Array.isArray(due) ? due : []).slice(0, limit).map((j) => String(j.id));
		} catch {
			throw new LiveError('FORGET_JOB_FAILED', 'resumeForgetJobs: the erasure job store could not be read');
		}
	}
	for (const jobId of ids) {
		out.total++;
		// A job a run of this process is still working on is not started twice.
		if (_running.has(jobId)) {
			out.results.push({ id: jobId, status: 'skipped' });
			continue;
		}
		const runId = randomUuid();
		const at = wallEpoch();
		let claim;
		try {
			claim = await _bounded(jobs.claim({ id: jobId, runId, processId: _processId(), aliveUntil: at + _PROCESS_TTL_MS, at }));
		} catch {
			out.failed++;
			out.results.push({ id: jobId, status: 'failed', code: 'FORGET_JOB_FAILED' });
			continue;
		}
		if (!claim) {
			out.results.push({ id: jobId, status: 'skipped' });
			continue;
		}
		// The steps still open: shared ones any process can finish, and the
		// owner's in-memory ones, which only the owner runs. A step finished by
		// an earlier run is not open and does not run again.
		/** @param {unknown} list */
		const names = (list) => Array.isArray(list) ? list.filter((n) => typeof n === 'string') : [];
		const job = {
			id: jobId, runId, attempts: Number(claim.attempts) || 1, claimed: true,
			owner: claim.owner === _processId(), ownerAlive: claim.ownerAlive !== false,
			shared: names(claim.shared), local: names(claim.local)
		};
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
			/** @type {{ userId: string, userIdHash: string, tenantId: string | null, cascade: any, waiting?: boolean }} */
			const run = { userId, userIdHash, tenantId: scope, cascade: stored };
			await _runErasure(jobs, job, run, onForget);
			if (run.waiting) {
				out.results.push({ id: jobId, status: 'waiting' });
			} else {
				out.completed++;
				out.results.push({ id: jobId, status: 'completed' });
			}
		} catch (err) {
			const code = String(/** @type {any} */ (err)?.code || 'INTERNAL_ERROR');
			// A stored job this run cannot even start still releases its lease
			// with a failure, so it stays listed and backs off like any other.
			if (!started) {
				const failedAt = wallEpoch();
				await _recordOutcome(jobs, 'fail', { id: jobId, runId, at: failedAt, code, failedSurfaces: [], sharedDone: [], localDone: [], rowsAffected: 0, retryAt: failedAt + _retryDelay(job.attempts) });
			}
			out.failed++;
			out.results.push({ id: jobId, status: 'failed', code });
		}
	}
	return out;
}
