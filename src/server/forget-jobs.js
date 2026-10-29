// @ts-check
// In-memory erasure job store: the reference implementation of the job store
// `configureForget({ jobs })` takes. A job is the durable record that an
// erasure was requested; it holds the raw user id only while the erasure is
// unfinished (a resume needs it) and keeps just the pseudonymous reference once
// every surface confirmed. A process restart loses this store, so a cluster or
// any deployment that must survive a crash wires a durable store with the same
// methods.

const _STATUSES = ['pending', 'failed', 'completed'];

/**
 * @typedef {object} ForgetJobIntent
 * @property {string} id - Pseudonymous job reference derived from the tenant and user.
 * @property {string} runId - Identifies one run of the job; outcomes of a superseded run are ignored.
 * @property {string} userIdHash - The erasure's audit identifier, as `onForget` receives it.
 * @property {string | null} tenantId
 * @property {string} userId
 * @property {boolean | { crdt?: string[] }} cascade
 * @property {number} at - Wall-clock ms.
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
			rowsAffected: j.rowsAffected,
			error: j.error === null ? null : { code: j.error.code, failedSurfaces: [...j.error.failedSurfaces] }
		};
	}

	return {
		/**
		 * Record that an erasure run is starting: create the job, or reopen an
		 * existing one under the new run. Must be durable before it returns.
		 * @param {ForgetJobIntent} intent
		 */
		begin(intent) {
			// A copy, as a durable store would serialize it, so the caller cannot
			// change what a later resume runs.
			const cascade = JSON.parse(JSON.stringify(intent.cascade));
			const j = jobs.get(intent.id);
			if (j === undefined) {
				jobs.set(intent.id, {
					id: intent.id, seq: ++seq, runId: intent.runId, userIdHash: intent.userIdHash,
					tenantId: intent.tenantId, userId: intent.userId, cascade,
					status: 'pending', attempts: 1, createdAt: intent.at, updatedAt: intent.at,
					completedAt: null, rowsAffected: null, error: null
				});
				return;
			}
			completed.delete(intent.id);
			Object.assign(j, {
				runId: intent.runId, userIdHash: intent.userIdHash, userId: intent.userId, cascade,
				status: 'pending', attempts: j.attempts + 1, updatedAt: intent.at, completedAt: null, rowsAffected: null
			});
		},

		/**
		 * Mark the run's job completed and drop the raw user id and cascade.
		 * Ignored unless `runId` is the job's current run.
		 * @param {{ id: string, runId: string, at: number, rowsAffected: number, surfaces: Record<string, number> }} outcome
		 */
		complete(outcome) {
			const j = jobs.get(outcome.id);
			if (j === undefined || j.runId !== outcome.runId || j.status === 'completed') return;
			Object.assign(j, {
				status: 'completed', updatedAt: outcome.at, completedAt: outcome.at,
				rowsAffected: outcome.rowsAffected, error: null, userId: null, cascade: null
			});
			completed.add(j.id);
			for (const id of completed) {
				if (completed.size <= max) break;
				completed.delete(id);
				jobs.delete(id);
			}
		},

		/**
		 * Mark the run's job failed, keeping what a resume needs. Ignored unless
		 * `runId` is the job's current run.
		 * @param {{ id: string, runId: string, at: number, code: string, failedSurfaces: string[] }} outcome
		 */
		fail(outcome) {
			const j = jobs.get(outcome.id);
			if (j === undefined || j.runId !== outcome.runId || j.status === 'completed') return;
			Object.assign(j, {
				status: 'failed', updatedAt: outcome.at,
				error: { code: outcome.code, failedSurfaces: [...outcome.failedSurfaces] }
			});
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
		 * What a resume needs to run an unfinished job, or null when the job is
		 * unknown or completed.
		 * @param {string} id
		 */
		intent(id) {
			const j = jobs.get(id);
			if (j === undefined || j.status === 'completed') return null;
			return { userId: j.userId, userIdHash: j.userIdHash, tenantId: j.tenantId, cascade: JSON.parse(JSON.stringify(j.cascade)) };
		},

		clear() {
			jobs.clear();
			completed.clear();
		}
	};
}
