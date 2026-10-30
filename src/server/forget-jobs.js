// @ts-check
// In-memory erasure job store: the reference implementation of the job store
// `configureForget({ jobs })` takes. A job is the durable record that an
// erasure was requested; it holds the raw user id only while the erasure is
// unfinished (a resume needs it) and keeps just the pseudonymous reference once
// every surface confirmed.
//
// A job is owned by the process that called `live.forget`: the in-memory
// surfaces it lists in `local` exist only in that process, while the steps in
// `shared` (the durable store, a shared dead-letter store) can be finished by
// any process. Processes report liveness with `beat`; a process whose last beat
// has lapsed is gone, and so is its memory. A run holds the job's lease for as
// long as its process is alive, so two processes never run one job at once.
// A process restart loses this store, so a cluster or any deployment that must
// survive a crash wires a durable store with the same methods.

const _STATUSES = ['pending', 'failed', 'completed'];

/**
 * @typedef {object} ForgetJobIntent
 * @property {string} id - Random job reference.
 * @property {string} runId - The run that holds the lease.
 * @property {string} processId - The calling process; it owns the job.
 * @property {number} aliveUntil - Wall-clock ms the calling process is alive until, unless it beats again.
 * @property {string} userIdHash - The erasure's audit identifier, as `onForget` receives it.
 * @property {string | null} tenantId
 * @property {string} userId
 * @property {boolean | { crdt?: string[] }} cascade
 * @property {string[]} shared - Steps any process can finish.
 * @property {string[]} local - In-memory steps only the owning process can finish.
 * @property {number} at - Wall-clock ms.
 */

/**
 * Create an in-memory erasure job store holding at most `max` jobs (default
 * 10000). A new job makes room by dropping the oldest completed job; an
 * unfinished job is never dropped, so when every held job is unfinished
 * `begin` throws and the erasure is refused before it touches anything.
 * @param {{ max?: number }} [options]
 */
export function createForgetJobStore(options = {}) {
	const max = Number.isInteger(options?.max) && /** @type {number} */ (options.max) > 0 ? /** @type {number} */ (options.max) : 10000;
	/** @type {Map<string, any>} */
	const jobs = new Map();
	/** @type {Set<string>} completed job ids, oldest completion first */
	const completed = new Set();
	/** @type {Map<string, number>} process id -> alive until */
	const beats = new Map();
	let seq = 0;

	/** @param {string} processId @param {number} at */
	function _alive(processId, at) {
		return (beats.get(processId) ?? -Infinity) > at;
	}

	/** @param {string} processId @param {number} aliveUntil */
	function _beat(processId, aliveUntil) {
		if ((beats.get(processId) ?? -Infinity) < aliveUntil) beats.set(processId, aliveUntil);
	}

	/**
	 * Whether `processId` may run the job at `at`: it is unfinished, no other
	 * live process's run holds it, and the process has work there - a shared
	 * step, its own job, or the job of an owner that is gone.
	 * @param {any} j @param {string} processId @param {number} at
	 */
	function _claimable(j, processId, at) {
		if (j.status === 'completed') return false;
		if (j.leaseRunId !== null && j.leaseProcessId !== processId && _alive(j.leaseProcessId, at)) return false;
		return j.shared.length > 0 || j.processId === processId || !_alive(j.processId, at);
	}

	/** @param {any} j */
	function _public(j) {
		return {
			id: j.id,
			processId: j.processId,
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

	/** @param {unknown} list */
	function _names(list) {
		return Array.isArray(list) ? list.filter((n) => typeof n === 'string') : [];
	}

	return {
		/**
		 * Record that a process is alive until `aliveUntil`.
		 * @param {{ processId: string, at: number, aliveUntil: number }} req
		 */
		beat(req) {
			_beat(req.processId, req.aliveUntil);
			for (const [id, until] of beats) if (until <= req.at) beats.delete(id);
		},

		/**
		 * Record a new job owned by the calling process, with that process's run
		 * holding the lease. Must be durable before it returns.
		 * @param {ForgetJobIntent} intent
		 */
		begin(intent) {
			if (jobs.has(intent.id)) throw new Error('forget job store: the job already exists');
			if (jobs.size >= max) {
				const oldest = completed.values().next().value;
				if (oldest === undefined) throw new Error('forget job store: full of unfinished jobs (max ' + max + ')');
				completed.delete(oldest);
				jobs.delete(oldest);
			}
			_beat(intent.processId, intent.aliveUntil);
			jobs.set(intent.id, {
				id: intent.id, seq: ++seq, processId: intent.processId, userIdHash: intent.userIdHash, tenantId: intent.tenantId,
				// Copies, as a durable store would serialize them, so the caller
				// cannot change what a later resume runs.
				userId: intent.userId, cascade: JSON.parse(JSON.stringify(intent.cascade)),
				shared: _names(intent.shared), local: _names(intent.local),
				status: 'pending', attempts: 1, createdAt: intent.at, updatedAt: intent.at,
				completedAt: null, rowsAffected: 0, error: null,
				leaseRunId: intent.runId, leaseProcessId: intent.processId, dueAt: intent.at
			});
		},

		/**
		 * Give the job's lease to a new run of `processId` when that process may
		 * run it. Resolves what the run needs, or null and changes nothing.
		 * @param {{ id: string, runId: string, processId: string, aliveUntil: number, at: number }} req
		 */
		claim(req) {
			_beat(req.processId, req.aliveUntil);
			const j = jobs.get(req.id);
			if (j === undefined || !_claimable(j, req.processId, req.at)) return null;
			Object.assign(j, { status: 'pending', attempts: j.attempts + 1, updatedAt: req.at, leaseRunId: req.runId, leaseProcessId: req.processId });
			return {
				userId: j.userId, userIdHash: j.userIdHash, tenantId: j.tenantId,
				cascade: JSON.parse(JSON.stringify(j.cascade)), attempts: j.attempts,
				owner: j.processId, ownerAlive: j.processId === req.processId || _alive(j.processId, req.at),
				shared: [...j.shared], local: [...j.local]
			};
		},

		/**
		 * Mark the job completed and drop the raw user id, cascade and step lists.
		 * Returns false, changing nothing, unless `runId` holds the lease.
		 * @param {{ id: string, runId: string, at: number, rowsAffected: number }} outcome
		 */
		complete(outcome) {
			const j = _held(outcome.id, outcome.runId);
			if (j === undefined) return false;
			Object.assign(j, {
				status: 'completed', updatedAt: outcome.at, completedAt: outcome.at,
				rowsAffected: j.rowsAffected + (Number(outcome.rowsAffected) || 0), error: null,
				userId: null, cascade: null, shared: [], local: [],
				leaseRunId: null, leaseProcessId: null, dueAt: null
			});
			completed.add(j.id);
			return true;
		},

		/**
		 * Mark the job failed, drop the steps the run finished from `shared` and
		 * `local`, release the lease and make it due again at `retryAt`.
		 * Returns false, changing nothing, unless `runId` holds the lease.
		 * @param {{ id: string, runId: string, at: number, code: string, failedSurfaces: string[], sharedDone: string[], localDone: string[], rowsAffected: number, retryAt: number }} outcome
		 */
		fail(outcome) {
			const j = _held(outcome.id, outcome.runId);
			if (j === undefined) return false;
			const sharedDone = new Set(_names(outcome.sharedDone));
			const localDone = new Set(_names(outcome.localDone));
			Object.assign(j, {
				status: 'failed', updatedAt: outcome.at, leaseRunId: null, leaseProcessId: null, dueAt: outcome.retryAt,
				shared: j.shared.filter((/** @type {string} */ n) => !sharedDone.has(n)),
				local: j.local.filter((/** @type {string} */ n) => !localDone.has(n)),
				rowsAffected: j.rowsAffected + (Number(outcome.rowsAffected) || 0),
				error: { code: outcome.code, failedSurfaces: _names(outcome.failedSurfaces) }
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
		 * Unfinished jobs `processId` may claim at `at` whose due time has come
		 * (a failed job's `retryAt`, a pending job's creation), earliest due
		 * first, at most `limit`.
		 * @param {{ at: number, limit: number, processId: string }} req
		 */
		due(req) {
			const out = [];
			for (const j of jobs.values()) if (j.dueAt !== null && j.dueAt <= req.at && _claimable(j, req.processId, req.at)) out.push(j);
			out.sort((a, b) => a.dueAt - b.dueAt || a.createdAt - b.createdAt || a.seq - b.seq);
			return out.slice(0, req.limit).map(_public);
		},

		clear() {
			jobs.clear();
			completed.clear();
			beats.clear();
		}
	};
}
