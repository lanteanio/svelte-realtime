// @ts-check
// In-memory erasure job store: the reference implementation of the job store
// `configureForget({ jobs })` takes. A job is the durable record that an
// erasure was requested and tracks its shared steps - the durable store and a
// shared dead-letter store - which any process can finish. In-memory erasure is
// not tracked here: each process keeps and retries its own.
//
// A run holds a job's lease until a time the store sets from its own clock;
// the run renews it while it works, and an expired lease lets another run
// claim the job. The job holds the raw user id only while it is open. A
// process restart loses this store, so a cluster or any deployment that must
// survive a crash wires a durable store with the same methods.

import { wallEpoch } from '../shared/runtime.js';
import { emitOperationalEvent } from '../shared/diagnostic.js';

const _STATUSES = ['pending', 'failed', 'exhausted', 'completed', 'abandoned'];
// A finished job never runs again and keeps nothing user-derived.
const _FINISHED = new Set(['completed', 'abandoned']);

/**
 * @typedef {object} ForgetJobIntent
 * @property {string} id - Random job reference.
 * @property {string} runId - The run that holds the lease.
 * @property {number} leaseMs - How long the lease lasts from now.
 * @property {string} userIdHash - The erasure's audit identifier, as `onForget` receives it.
 * @property {string | null} tenantId
 * @property {string} userId
 * @property {boolean | { crdt?: string[] }} cascade
 * @property {string[]} shared - The shared steps the job has to finish.
 */

/**
 * Create an in-memory erasure job store holding at most `max` jobs (default
 * 10000). A new job makes room by dropping the oldest job that will not run
 * by itself again - completed or abandoned first, then exhausted ones, each
 * reported as `forget.job-evicted`. A pending or failed job is never dropped,
 * so when every held job is one `begin` throws and the erasure is refused
 * before it touches anything. Times come from the process clock.
 * @param {{ max?: number }} [options]
 */
export function createForgetJobStore(options = {}) {
	const max = Number.isInteger(options?.max) && /** @type {number} */ (options.max) > 0 ? /** @type {number} */ (options.max) : 10000;
	/** @type {Map<string, any>} */
	const jobs = new Map();
	/** @type {Set<string>} ids of jobs that will not run by themselves, oldest first */
	const settled = new Set();
	let seq = 0;

	/** @param {any} j @param {number} now */
	function _leased(j, now) {
		return j.leaseRunId !== null && j.leaseUntil > now;
	}

	/** @param {any} j */
	function _public(j) {
		return {
			id: j.id,
			userIdHash: j.userIdHash,
			tenantId: j.tenantId,
			status: j.status,
			attempts: j.attempts,
			createdAt: j.createdAt,
			updatedAt: j.updatedAt,
			completedAt: j.completedAt,
			retryAt: j.status === 'failed' ? j.retryAt : null,
			rowsAffected: j.rowsAffected,
			error: j.error === null ? null : { code: j.error.code, failedSurfaces: [...j.error.failedSurfaces] }
		};
	}

	/** @param {string} id @param {string} runId */
	function _held(id, runId) {
		const j = jobs.get(id);
		return j !== undefined && !_FINISHED.has(j.status) && j.leaseRunId === runId ? j : undefined;
	}

	/** @param {unknown} list */
	function _names(list) {
		return Array.isArray(list) ? list.filter((n) => typeof n === 'string') : [];
	}

	/** @param {any} j */
	function _settle(j) {
		settled.delete(j.id);
		settled.add(j.id);
	}

	function _makeRoom() {
		/** @type {string | undefined} */
		let drop;
		for (const id of settled) if (_FINISHED.has(jobs.get(id).status)) { drop = id; break; }
		if (drop === undefined) {
			drop = settled.values().next().value;
			if (drop === undefined) throw new Error('forget job store: full of open jobs (max ' + max + ')');
			try {
				emitOperationalEvent({
					source: 'svelte-realtime', component: 'server.forget', event: 'forget.job-evicted',
					severity: 'error', dataClass: 'operational',
					message: 'The in-memory erasure job store dropped an exhausted job to record a new erasure.',
					attributes: { job: drop }
				});
			} catch { /* Diagnostic failures must not refuse the new erasure. */ }
		}
		settled.delete(drop);
		jobs.delete(drop);
	}

	return {
		/**
		 * Record a new job whose run holds the lease for `leaseMs`. Must be
		 * durable before it returns.
		 * @param {ForgetJobIntent} intent
		 */
		begin(intent) {
			if (jobs.has(intent.id)) throw new Error('forget job store: the job already exists');
			if (jobs.size >= max) _makeRoom();
			const now = wallEpoch();
			jobs.set(intent.id, {
				id: intent.id, seq: ++seq, userIdHash: intent.userIdHash, tenantId: intent.tenantId,
				// Copies, as a durable store would serialize them, so the caller
				// cannot change what a later resume runs.
				userId: intent.userId, cascade: JSON.parse(JSON.stringify(intent.cascade)), shared: _names(intent.shared),
				status: 'pending', attempts: 1, createdAt: now, updatedAt: now, completedAt: null,
				retryAt: null, rowsAffected: 0, error: null,
				leaseRunId: intent.runId, leaseUntil: now + intent.leaseMs
			});
		},

		/**
		 * Extend the lease of the run that holds it.
		 * @param {{ id: string, runId: string, leaseMs: number }} req
		 */
		renew(req) {
			const j = _held(req.id, req.runId);
			if (j === undefined) return false;
			j.leaseUntil = wallEpoch() + req.leaseMs;
			return true;
		},

		/**
		 * Give the lease of a pending or failed job (or, with `exhausted`, an
		 * exhausted one) to a new run, unless an unexpired lease holds it.
		 * Resolves what the run needs, or null and changes nothing.
		 * @param {{ id: string, runId: string, leaseMs: number, exhausted?: boolean }} req
		 */
		claim(req) {
			const j = jobs.get(req.id);
			const now = wallEpoch();
			if (j === undefined || _FINISHED.has(j.status) || (j.status === 'exhausted' && req.exhausted !== true) || _leased(j, now)) return null;
			settled.delete(j.id);
			Object.assign(j, { status: 'pending', attempts: j.attempts + 1, updatedAt: now, leaseRunId: req.runId, leaseUntil: now + req.leaseMs });
			return {
				userId: j.userId, userIdHash: j.userIdHash, tenantId: j.tenantId,
				cascade: JSON.parse(JSON.stringify(j.cascade)), attempts: j.attempts, shared: [...j.shared]
			};
		},

		/**
		 * Mark the job completed and drop the raw user id, its audit hash, the
		 * cascade and the step list: a finished job keeps nothing user-derived.
		 * Returns false, changing nothing, unless `runId` holds the lease.
		 * @param {{ id: string, runId: string, rowsAffected: number }} outcome
		 */
		complete(outcome) {
			const j = _held(outcome.id, outcome.runId);
			if (j === undefined) return false;
			const now = wallEpoch();
			Object.assign(j, {
				status: 'completed', updatedAt: now, completedAt: now, retryAt: null,
				rowsAffected: j.rowsAffected + (Number(outcome.rowsAffected) || 0), error: null,
				userId: null, userIdHash: null, cascade: null, shared: [], leaseRunId: null, leaseUntil: 0
			});
			_settle(j);
			return true;
		},

		/**
		 * Mark the job failed, drop the steps the run finished, release the
		 * lease and make it due again `retryAfterMs` from now - or, with
		 * `exhausted`, mark it exhausted and never due by itself again. Returns
		 * false, changing nothing, unless `runId` holds the lease.
		 * @param {{ id: string, runId: string, code: string, failedSurfaces: string[], sharedDone: string[], rowsAffected: number, retryAfterMs: number, exhausted: boolean }} outcome
		 */
		fail(outcome) {
			const j = _held(outcome.id, outcome.runId);
			if (j === undefined) return false;
			const now = wallEpoch();
			const done = new Set(_names(outcome.sharedDone));
			const exhausted = outcome.exhausted === true;
			Object.assign(j, {
				status: exhausted ? 'exhausted' : 'failed', updatedAt: now,
				retryAt: exhausted ? null : now + (Number(outcome.retryAfterMs) || 0),
				shared: j.shared.filter((/** @type {string} */ n) => !done.has(n)),
				rowsAffected: j.rowsAffected + (Number(outcome.rowsAffected) || 0),
				error: { code: outcome.code, failedSurfaces: _names(outcome.failedSurfaces) },
				leaseRunId: null, leaseUntil: 0
			});
			if (exhausted) _settle(j);
			return true;
		},

		/**
		 * Give up an open job whose lease has expired or is held by `runId`:
		 * mark it abandoned and drop everything user-derived. Returns whether
		 * it did.
		 * @param {{ id: string, runId?: string }} req
		 */
		abandon(req) {
			const j = jobs.get(req.id);
			const now = wallEpoch();
			if (j === undefined || _FINISHED.has(j.status)) return false;
			if (_leased(j, now) && j.leaseRunId !== req.runId) return false;
			Object.assign(j, {
				status: 'abandoned', updatedAt: now, retryAt: null,
				userId: null, userIdHash: null, cascade: null, shared: [], leaseRunId: null, leaseUntil: 0
			});
			_settle(j);
			return true;
		},

		/**
		 * Jobs oldest first (by creation), optionally one status, at most `limit`
		 * (default 100). Never includes the raw user id.
		 * @param {{ status?: 'pending' | 'failed' | 'exhausted' | 'completed' | 'abandoned', limit?: number }} [filter]
		 */
		list(filter = {}) {
			const limit = Number.isInteger(filter.limit) && /** @type {number} */ (filter.limit) > 0 ? /** @type {number} */ (filter.limit) : 100;
			const status = filter.status !== undefined && _STATUSES.includes(filter.status) ? filter.status : undefined;
			const out = [];
			for (const j of jobs.values()) if (status === undefined || j.status === status) out.push(j);
			out.sort((a, b) => a.createdAt - b.createdAt || a.seq - b.seq);
			return out.slice(0, limit).map(_public);
		},

		/**
		 * Jobs a resume may claim now, at most `limit`: pending or failed ones
		 * past their retry time with no unexpired lease, earliest due first; or,
		 * with `exhausted`, the exhausted ones, oldest first.
		 * @param {{ limit: number, exhausted?: boolean }} req
		 */
		due(req) {
			const now = wallEpoch();
			const out = [];
			for (const j of jobs.values()) {
				if (_leased(j, now)) continue;
				if (req.exhausted === true ? j.status === 'exhausted' : (j.status === 'pending' || (j.status === 'failed' && j.retryAt <= now))) out.push(j);
			}
			/** @param {any} j */
			const dueAt = (j) => (j.status === 'failed' ? j.retryAt : j.status === 'pending' ? j.leaseUntil : j.updatedAt);
			out.sort((a, b) => dueAt(a) - dueAt(b) || a.createdAt - b.createdAt || a.seq - b.seq);
			return out.slice(0, req.limit).map(_public);
		},

		clear() {
			jobs.clear();
			settled.clear();
		}
	};
}
