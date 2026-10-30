// @ts-check
// In-memory erasure job store: the reference implementation of the job store
// `configureForget({ jobs })` takes. A job is the durable record that an
// erasure was requested; it holds the raw user id only while the erasure is
// unfinished (a resume needs it) and keeps just the pseudonymous reference once
// every surface confirmed. A run holds the job's lease until it records an
// outcome or the lease expires, so two processes never run one job at once.
// A process restart loses this store, so a cluster or any deployment that must
// survive a crash wires a durable store with the same methods.

const _STATUSES = ['pending', 'failed', 'completed'];

/**
 * @typedef {object} ForgetJobIntent
 * @property {string} id - Random job reference.
 * @property {string} runId - The run that holds the lease.
 * @property {string} userIdHash - The erasure's audit identifier, as `onForget` receives it.
 * @property {string | null} tenantId
 * @property {string} userId
 * @property {boolean | { crdt?: string[] }} cascade
 * @property {number} at - Wall-clock ms.
 * @property {number} leaseUntil - Wall-clock ms the lease of `runId` ends.
 */

/**
 * Create an in-memory erasure job store. Unfinished jobs are always kept;
 * finished ones are kept for audit up to `max` (default 1000), oldest
 * completion dropped first.
 * @param {{ max?: number }} [options]
 */
export function createForgetJobStore(options = {}) {
	const max = Number.isInteger(options?.max) && /** @type {number} */ (options.max) > 0 ? /** @type {number} */ (options.max) : 1000;
	/** @type {Map<string, any>} */
	const jobs = new Map();
	/** @type {Set<string>} completed job ids, oldest completion first */
	const completed = new Set();
	let seq = 0;

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
			retryAt: j.status === 'failed' ? j.dueAt : null,
			rowsAffected: j.rowsAffected,
			error: j.error === null ? null : { code: j.error.code, failedSurfaces: [...j.error.failedSurfaces] }
		};
	}

	/** @param {string} id @param {string} runId */
	function _held(id, runId) {
		const j = jobs.get(id);
		return j !== undefined && j.status !== 'completed' && j.leaseRunId === runId ? j : undefined;
	}

	return {
		/**
		 * Record a new job with its first run holding the lease. Must be durable
		 * before it returns.
		 * @param {ForgetJobIntent} intent
		 */
		begin(intent) {
			if (jobs.has(intent.id)) throw new Error('forget job store: the job already exists');
			jobs.set(intent.id, {
				id: intent.id, seq: ++seq, userIdHash: intent.userIdHash, tenantId: intent.tenantId,
				// A copy, as a durable store would serialize it, so the caller
				// cannot change what a later resume runs.
				userId: intent.userId, cascade: JSON.parse(JSON.stringify(intent.cascade)),
				status: 'pending', attempts: 1, createdAt: intent.at, updatedAt: intent.at,
				completedAt: null, rowsAffected: null, error: null,
				leaseRunId: intent.runId, dueAt: intent.leaseUntil
			});
		},

		/**
		 * Take the lease of an unfinished job for a new run, unless another run
		 * holds an unexpired lease. Resolves what the run needs, or null.
		 * @param {{ id: string, runId: string, at: number, leaseUntil: number }} req
		 */
		claim(req) {
			const j = jobs.get(req.id);
			if (j === undefined || j.status === 'completed') return null;
			if (j.leaseRunId !== null && j.dueAt > req.at) return null;
			Object.assign(j, { status: 'pending', attempts: j.attempts + 1, updatedAt: req.at, leaseRunId: req.runId, dueAt: req.leaseUntil });
			return { userId: j.userId, userIdHash: j.userIdHash, tenantId: j.tenantId, cascade: JSON.parse(JSON.stringify(j.cascade)), attempts: j.attempts };
		},

		/**
		 * Mark the job completed and drop the raw user id and cascade. Returns
		 * false, changing nothing, unless `runId` holds the lease.
		 * @param {{ id: string, runId: string, at: number, rowsAffected: number, surfaces: Record<string, number> }} outcome
		 */
		complete(outcome) {
			const j = _held(outcome.id, outcome.runId);
			if (j === undefined) return false;
			Object.assign(j, {
				status: 'completed', updatedAt: outcome.at, completedAt: outcome.at,
				rowsAffected: outcome.rowsAffected, error: null, userId: null, cascade: null,
				leaseRunId: null, dueAt: null
			});
			completed.add(j.id);
			for (const id of completed) {
				if (completed.size <= max) break;
				completed.delete(id);
				jobs.delete(id);
			}
			return true;
		},

		/**
		 * Mark the job failed, release the lease and make it due again at
		 * `retryAt`, keeping what a resume needs. Returns false, changing
		 * nothing, unless `runId` holds the lease.
		 * @param {{ id: string, runId: string, at: number, code: string, failedSurfaces: string[], retryAt: number }} outcome
		 */
		fail(outcome) {
			const j = _held(outcome.id, outcome.runId);
			if (j === undefined) return false;
			Object.assign(j, {
				status: 'failed', updatedAt: outcome.at, leaseRunId: null, dueAt: outcome.retryAt,
				error: { code: outcome.code, failedSurfaces: [...outcome.failedSurfaces] }
			});
			return true;
		},

		/**
		 * Jobs oldest first (by creation), optionally one status, at most `limit`
		 * (default 100). Never includes the raw user id.
		 * @param {{ status?: 'pending' | 'failed' | 'completed', limit?: number }} [filter]
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
		 * Unfinished jobs a resume may claim at `at` (a failed job past its retry
		 * time, a pending job whose lease expired), longest due first, at most
		 * `limit`.
		 * @param {{ at: number, limit: number }} req
		 */
		due(req) {
			const out = [];
			for (const j of jobs.values()) if (j.status !== 'completed' && j.dueAt <= req.at) out.push(j);
			out.sort((a, b) => a.dueAt - b.dueAt || a.createdAt - b.createdAt || a.seq - b.seq);
			return out.slice(0, req.limit).map(_public);
		},

		clear() {
			jobs.clear();
			completed.clear();
		}
	};
}
