// Erasure jobs: with a job store configured, live.forget records the erasure
// before touching any surface, keeps it pending until every surface confirms,
// and records the outcome against a pseudonymous reference. A process that dies
// part-way leaves a pending job that a later process resumes with the same store.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash, createHmac } from 'node:crypto';
import {
	live, configureForget, configureWebhooks, createForgetJobStore, createDeadLetterStore, listForgetJobs, resumeForgetJobs,
	abandonForgetJob, _resetForget, setOperationalEventSink
} from '../src/server.js';
import { _pushRegistry } from '../src/server/push.js';
import { _crdtDecls } from '../src/server/crdt.js';
import { _resetReplayRouting } from '../src/server/replay-routing.js';
import { setRuntimeEnv, resetRuntimeEnv } from '../src/shared/runtime.js';

const KEY = 'k'.repeat(32);
/** Move the wall clock past every lease and retry delay, as a later resume sees it. */
const later = () => setRuntimeEnv({ clock: { wallEpoch: () => Date.now() + 24 * 3_600_000 } });
const hmac = (value) => createHmac('sha256', KEY).update(value).digest('hex').slice(0, 32);
const sha = (value) => createHash('sha256').update(value).digest('hex').slice(0, 32);

/** Durable rows shared by every "process", the way a database outlives a restart. */
let rows;
const durable = () => ({
	async purgeUser(_tenantId, userId) {
		const n = rows.get(userId) || 0;
		rows.delete(userId);
		return n;
	}
});
/** Deletes one row and then fails, leaving the erasure half-done. */
const partial = () => ({
	async purgeUser(_tenantId, userId) {
		rows.set(userId, (rows.get(userId) || 0) - 1);
		throw new Error('connection lost while erasing ' + userId);
	}
});

let events;
let restoreSink;
beforeEach(() => {
	_resetForget();
	configureWebhooks({ deadLetter: false });
	rows = new Map([['alice', 3], ['bob', 2]]);
	events = [];
	restoreSink = setOperationalEventSink((e) => events.push(e));
});
afterEach(() => {
	_resetForget();
	_pushRegistry.clear();
	restoreSink();
	resetRuntimeEnv();
});

describe('erasure jobs', () => {
	it('resumes and completes an erasure whose process died part-way', async () => {
		const jobs = createForgetJobStore();
		// The process dies after the durable leg failed, before it could record
		// the failure: the store only ever sees the intent.
		const dying = { ...jobs, fail() { throw new Error('process exited'); } };
		configureForget({ store: partial(), jobs: dying });
		await expect(live.forget('alice', { tenantId: null })).rejects.toMatchObject({ code: 'FORGET_STORE_FAILED' });
		expect(rows.get('alice')).toBe(2);

		// A new process: fresh in-memory state, the same job store and database.
		_resetForget();
		configureForget({ store: durable(), jobs });
		later();
		const pending = await listForgetJobs({ status: 'pending' });
		expect(pending).toHaveLength(1);
		expect(pending[0]).toMatchObject({ userIdHash: sha('alice'), tenantId: null, attempts: 1 });
		expect(JSON.stringify(pending)).not.toContain('alice');

		const onForget = vi.fn();
		const res = await resumeForgetJobs({ onForget });
		expect(res).toEqual({ total: 1, completed: 1, failed: 0, results: [{ id: pending[0].id, status: 'completed' }] });
		expect(rows.has('alice')).toBe(false);
		expect(rows.get('bob')).toBe(2);
		expect(onForget).toHaveBeenCalledWith(expect.objectContaining({ userIdHash: sha('alice'), tenantId: null, rowsAffected: 2 }));
		const [done] = await listForgetJobs();
		expect(done).toMatchObject({ status: 'completed', attempts: 2, rowsAffected: 2, error: null });
		expect(typeof done.completedAt).toBe('number');
		// A completed job keeps only the pseudonymous reference and cannot be claimed.
		expect(await jobs.claim({ id: done.id, runId: 'r', at: Date.now() + 1e9, leaseUntil: Date.now() + 2e9 })).toBeNull();
		expect(await resumeForgetJobs()).toEqual({ total: 0, completed: 0, failed: 0, results: [] });
	});

	it('records the intent before any surface is touched', async () => {
		let seen = null;
		configureForget({ jobs: true, store: { async purgeUser() { seen = await listForgetJobs({ status: 'pending' }); return 0; } } });
		await live.forget('alice', { tenantId: null });
		expect(seen).toHaveLength(1);
		expect(seen[0].status).toBe('pending');
	});

	it('records a repeated erasure of the same user as a new job', async () => {
		configureForget({ store: durable(), jobs: true });
		const first = await live.forget('alice', { tenantId: null });
		const second = await live.forget('alice', { tenantId: null });
		expect(second.job).not.toBe(first.job);
		const all = await listForgetJobs();
		expect(all.map((j) => j.id)).toEqual([first.job, second.job]);
		expect(all.every((j) => j.status === 'completed' && j.attempts === 1)).toBe(true);
	});

	it('records a failure against the hashed reference only', async () => {
		const user = 'alice@example.test';
		configureForget({ store: partial(), jobs: true, hashKey: KEY });
		const err = await live.forget(user, { tenantId: 'acme' }).catch((e) => e);
		const id = err.job;
		expect(err.code).toBe('FORGET_STORE_FAILED');
		const failed = await listForgetJobs({ status: 'failed' });
		expect(failed).toEqual([{
			id, processId: expect.any(String), userIdHash: hmac(user), tenantId: 'acme', status: 'failed', attempts: 1,
			createdAt: expect.any(Number), updatedAt: expect.any(Number), completedAt: null, retryAt: expect.any(Number), rowsAffected: 0,
			error: { code: 'FORGET_STORE_FAILED', failedSurfaces: ['durable'] }
		}]);
		const incomplete = events.filter((e) => e.event === 'forget.incomplete');
		expect(incomplete).toHaveLength(1);
		expect(incomplete[0].attributes).toMatchObject({ job: id, failedSurfaces: ['durable'] });
		expect(JSON.stringify([failed, events])).not.toContain('alice');

		// The store recovers; resuming the failed job completes it.
		configureForget({ store: durable() });
		expect(await resumeForgetJobs({ id })).toMatchObject({ completed: 1, results: [{ id, status: 'completed' }] });
		expect((await listForgetJobs())[0]).toMatchObject({ status: 'completed', attempts: 2, error: null });
	});

	it('keeps a job failed when the resumed run fails again', async () => {
		configureForget({ store: partial(), jobs: true });
		await expect(live.forget('alice', { tenantId: null })).rejects.toMatchObject({ code: 'FORGET_STORE_FAILED' });
		later();
		const res = await resumeForgetJobs();
		expect(res).toMatchObject({ total: 1, completed: 0, failed: 1, results: [{ status: 'failed', code: 'FORGET_STORE_FAILED' }] });
		expect((await listForgetJobs({ status: 'failed' }))[0].attempts).toBe(2);
	});

	it('erases nothing when the intent cannot be recorded', async () => {
		const purgeUser = vi.fn(async () => 1);
		const jobs = createForgetJobStore();
		configureForget({ store: { purgeUser }, jobs: { ...jobs, begin() { throw new Error('job store offline'); } } });
		await expect(live.forget('alice', { tenantId: null })).rejects.toMatchObject({ code: 'FORGET_JOB_FAILED' });
		expect(purgeUser).not.toHaveBeenCalled();
	});

	it('returns a completed erasure even when its outcome cannot be recorded, and resume finishes the record', async () => {
		const jobs = createForgetJobStore();
		configureForget({ store: durable(), jobs: { ...jobs, complete() { throw new Error('job store offline'); } } });
		await expect(live.forget('alice', { tenantId: null })).resolves.toMatchObject({ ok: true, rowsAffected: 3 });
		expect(events.filter((e) => e.event === 'forget.job-unrecorded')).toHaveLength(1);
		expect((await listForgetJobs())[0].status).toBe('pending');
		configureForget({ jobs });
		// No run of this process holds it any more, so this process finishes it.
		expect(await resumeForgetJobs()).toMatchObject({ completed: 1 });
		expect((await listForgetJobs())[0]).toMatchObject({ status: 'completed' });
	});

	it('requires a tenant scope once a job store is configured', async () => {
		configureForget({ jobs: true });
		await expect(live.forget('alice')).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
		expect(await listForgetJobs()).toEqual([]);
	});

	it('is inert without a job store', async () => {
		expect(await listForgetJobs()).toEqual([]);
		expect(await resumeForgetJobs()).toEqual({ total: 0, completed: 0, failed: 0, results: [] });
		const res = await live.forget('alice');
		expect(res).not.toHaveProperty('job');
	});

	it('validates configuration and options', async () => {
		expect(() => configureForget({ jobs: { begin() {} } })).toThrow(/jobs/);
		await expect(listForgetJobs({ status: 'done' })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
		await expect(listForgetJobs({ limit: 0 })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
		await expect(resumeForgetJobs({ limit: 1001 })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
		await expect(resumeForgetJobs({ id: 7 })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
		await expect(resumeForgetJobs({ onForget: 'x' })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
	});
});

describe('createForgetJobStore', () => {
	const intent = (over = {}) => ({
		id: 'j1', runId: 'r1', processId: 'A', aliveUntil: 100, userIdHash: 'h', tenantId: null, userId: 'alice',
		cascade: { crdt: ['doc'] }, shared: ['durable'], local: ['push', 'crdtDocs'], at: 10, ...over
	});
	const claim = (over = {}) => ({ id: 'j1', runId: 'r2', processId: 'B', aliveUntil: 1000, at: 50, ...over });
	const fail = (over = {}) => ({ id: 'j1', runId: 'r1', at: 20, code: 'FORGET_STORE_FAILED', failedSurfaces: ['durable'], sharedDone: [], localDone: ['push', 'crdtDocs'], rowsAffected: 2, retryAt: 30, ...over });

	it('leases a job to one run while its process lives and fences outcomes of other runs', () => {
		const s = createForgetJobStore();
		const cascade = { crdt: ['doc'] };
		s.begin(intent({ cascade }));
		cascade.crdt.push('mutated');
		expect(() => s.begin(intent())).toThrow();
		// A's run holds the lease while A is alive.
		expect(s.claim(claim())).toBeNull();
		expect(s.due({ at: 50, limit: 10, processId: 'B' })).toEqual([]);
		// A is gone at 100: B takes over, and A's late outcomes are fenced.
		expect(s.due({ at: 100, limit: 10, processId: 'B' }).map((j) => j.id)).toEqual(['j1']);
		expect(s.claim(claim({ at: 100 }))).toEqual({
			userId: 'alice', userIdHash: 'h', tenantId: null, cascade: { crdt: ['doc'] }, attempts: 2,
			owner: 'A', ownerAlive: false, shared: ['durable'], local: ['push', 'crdtDocs']
		});
		expect(s.complete({ id: 'j1', runId: 'r1', at: 150, rowsAffected: 1 })).toBe(false);
		expect(s.fail(fail({ at: 150 }))).toBe(false);
		expect(s.list()[0]).toMatchObject({ status: 'pending', attempts: 2, processId: 'A', updatedAt: 100, rowsAffected: 0 });
		expect(s.complete({ id: 'j1', runId: 'r2', at: 160, rowsAffected: 3 })).toBe(true);
		expect(s.list()[0]).toMatchObject({ status: 'completed', completedAt: 160, retryAt: null, rowsAffected: 3, error: null });
		expect(s.claim(claim({ runId: 'r3', at: 2000 }))).toBeNull();
		expect(JSON.stringify(s.list())).not.toContain('alice');
	});

	it('leaves a live owner its in-memory steps and lets any process finish the shared ones', () => {
		const s = createForgetJobStore();
		s.begin(intent());
		expect(s.fail(fail({ localDone: ['push'], failedSurfaces: ['crdtDocs', 'durable'], code: 'FORGET_INCOMPLETE' }))).toBe(true);
		expect(s.list({ status: 'failed' })[0]).toMatchObject({ retryAt: 30, rowsAffected: 2, error: { code: 'FORGET_INCOMPLETE', failedSurfaces: ['crdtDocs', 'durable'] } });
		// B may run the open shared step; A, alive, still owes crdtDocs.
		expect(s.claim(claim({ at: 40 }))).toMatchObject({ owner: 'A', ownerAlive: true, shared: ['durable'], local: ['crdtDocs'] });
		expect(s.fail(fail({ runId: 'r2', at: 45, sharedDone: ['durable'], localDone: [], failedSurfaces: ['crdtDocs'], code: 'FORGET_INCOMPLETE', rowsAffected: 1, retryAt: 45 }))).toBe(true);
		// Only the owner's step is open now: B has nothing to do there, A has.
		expect(s.due({ at: 50, limit: 10, processId: 'B' })).toEqual([]);
		expect(s.claim(claim({ runId: 'r3', at: 50 }))).toBeNull();
		expect(s.due({ at: 50, limit: 10, processId: 'A' }).map((j) => j.id)).toEqual(['j1']);
		expect(s.claim(claim({ runId: 'r4', processId: 'A', at: 50 }))).toMatchObject({ owner: 'A', shared: [], local: ['crdtDocs'], attempts: 3 });
		expect(s.complete({ id: 'j1', runId: 'r4', at: 60, rowsAffected: 1 })).toBe(true);
		expect(s.list()[0]).toMatchObject({ status: 'completed', rowsAffected: 4 });
	});

	it('orders due jobs by how long they have been due', () => {
		const s = createForgetJobStore();
		s.begin(intent({ id: 'a', at: 1 }));
		s.begin(intent({ id: 'b', at: 2 }));
		s.begin(intent({ id: 'c', at: 3 }));
		s.fail(fail({ id: 'a', retryAt: 50 }));
		s.fail(fail({ id: 'b', retryAt: 20 }));
		s.fail(fail({ id: 'c', retryAt: 500 }));
		expect(s.due({ at: 100, limit: 10, processId: 'B' }).map((j) => j.id)).toEqual(['b', 'a']);
		expect(s.due({ at: 100, limit: 1, processId: 'B' }).map((j) => j.id)).toEqual(['b']);
	});

	it('lists oldest first and drops the oldest completion to stay within max', () => {
		const s = createForgetJobStore({ max: 3 });
		for (let i = 0; i < 4; i++) {
			s.begin(intent({ id: 'c' + i, runId: 'r', at: i + 1 }));
			s.complete({ id: 'c' + i, runId: 'r', at: i + 1, rowsAffected: 0 });
		}
		s.begin(intent({ id: 'p', runId: 'r', at: 0 }));
		expect(s.list().map((j) => j.id)).toEqual(['p', 'c2', 'c3']);
		expect(s.list({ limit: 1 }).map((j) => j.id)).toEqual(['p']);
	});
});

describe('erasure job identity', () => {
	it('gives every call its own job, so a failed run is not hidden by a concurrent success', async () => {
		// Two workers erase the same user at once (aggregates are per worker);
		// the dead-letter purge fails for the first and succeeds for the second.
		let purges = 0;
		configureWebhooks({ deadLetter: { add() { return null; }, purgeUser() { if (purges++ === 0) throw new Error('offline'); return 0; } } });
		configureForget({ store: durable(), jobs: true });
		const [a, b] = await Promise.allSettled([live.forget('alice', { tenantId: null }), live.forget('alice', { tenantId: null })]);
		expect(a.status).toBe('rejected');
		expect(b.status).toBe('fulfilled');
		const failed = await listForgetJobs({ status: 'failed' });
		expect(failed).toHaveLength(1);
		expect(failed[0].id).toBe(a.reason.job);
		expect((await listForgetJobs({ status: 'completed' })).map((j) => j.id)).toEqual([b.value.job]);
		configureWebhooks({ deadLetter: false });
	});

	it('uses an unguessable job id and keeps it out of client-visible error details', async () => {
		configureForget({ store: partial(), jobs: true, hashKey: KEY });
		const first = await live.forget('alice', { tenantId: 'acme' }).catch((e) => e);
		const second = await live.forget('alice', { tenantId: 'acme' }).catch((e) => e);
		expect(first.code).toBe('FORGET_STORE_FAILED');
		expect(typeof first.job).toBe('string');
		expect(first.job).not.toBe(second.job);
		for (const derived of [sha(JSON.stringify(['acme', 'alice'])), hmac(JSON.stringify(['acme', 'alice']))]) {
			expect(first.job).not.toBe(derived);
		}
		expect(first.details).toBeUndefined();
		expect(JSON.stringify(first)).not.toContain(first.job);
		expect(Object.keys(first)).not.toContain('job');
	});
});

describe('resuming erasure jobs across replicas', () => {
	afterEach(() => { resetRuntimeEnv(); vi.resetModules(); });

	it('lets only one replica run a job at a time', async () => {
		const jobs = createForgetJobStore();
		configureForget({ store: partial(), jobs });
		await expect(live.forget('alice', { tenantId: null })).rejects.toMatchObject({ code: 'FORGET_STORE_FAILED' });
		setRuntimeEnv({ clock: { wallEpoch: () => Date.now() + 3_600_000 } }); // past any retry delay

		// A second replica: its own module instance, the same job store.
		vi.resetModules();
		const other = await import('../src/server.js');
		let release;
		const gate = new Promise((r) => { release = r; });
		let purges = 0;
		const blocking = { async purgeUser() { purges++; await gate; return 0; } };
		configureForget({ store: blocking, jobs });
		other.configureForget({ store: blocking, jobs });

		const first = resumeForgetJobs();
		await vi.waitFor(() => expect(purges).toBe(1));
		const [held] = await other.listForgetJobs({ status: 'pending' });
		const second = Promise.all([other.resumeForgetJobs(), other.resumeForgetJobs({ id: held.id })]);
		await new Promise((r) => setTimeout(r, 20));
		release();
		expect(purges).toBe(1);
		expect(await second).toEqual([
			{ total: 0, completed: 0, failed: 0, results: [] },
			{ total: 1, completed: 0, failed: 0, results: [{ id: held.id, status: 'skipped' }] }
		]);
		expect(await first).toMatchObject({ completed: 1 });
		other.configureForget(null);
	});

	it('backs off a failing job so newer due jobs run first', async () => {
		let t = 1_000_000;
		setRuntimeEnv({ clock: { wallEpoch: () => t } });
		let bobFailures = 1;
		const store = { async purgeUser(_t, userId) {
			if (userId === 'alice' || bobFailures-- > 0) throw new Error('offline');
			return 0;
		} };
		configureForget({ store, jobs: true });
		await live.forget('alice', { tenantId: null }).catch(() => {});
		t += 10;
		await live.forget('bob', { tenantId: null }).catch(() => {});

		// Nothing is due until its retry delay has passed.
		expect(await resumeForgetJobs()).toMatchObject({ total: 0 });
		const [alice, bob] = await listForgetJobs({ status: 'failed' });
		expect(alice.retryAt).toBeGreaterThan(t);

		t += 60_000;
		expect((await resumeForgetJobs({ limit: 1 })).results).toEqual([{ id: alice.id, status: 'failed', code: 'FORGET_STORE_FAILED' }]);
		t += 1;
		expect((await resumeForgetJobs({ limit: 1 })).results).toEqual([{ id: bob.id, status: 'completed' }]);
		const after = (await listForgetJobs({ status: 'failed' }))[0];
		expect(after).toMatchObject({ id: alice.id, attempts: 2 });
		expect(after.retryAt - after.updatedAt).toBeGreaterThan(alice.retryAt - alice.updatedAt);
	});
});

describe('resuming a partly finished erasure', () => {
	afterEach(() => { _crdtDecls.clear(); configureWebhooks({ deadLetter: false }); });

	it('skips the surfaces an earlier run already finished', async () => {
		const drop = vi.fn(() => true);
		_crdtDecls.set('notes', { authority: { drop } });
		const purgeUser = vi.fn(() => 0);
		configureWebhooks({ deadLetter: { add() { return null; }, purgeUser } });
		let durableFailures = 1;
		const store = { async purgeUser() { if (durableFailures-- > 0) throw new Error('offline'); return 1; } };
		configureForget({ store, jobs: true });
		const err = await live.forget('alice', { tenantId: null, cascade: { crdt: ['notes:1'] } }).catch((e) => e);
		expect(err.code).toBe('FORGET_STORE_FAILED');
		expect(drop).toHaveBeenCalledTimes(1);

		// The document is in use again before the resume; dropping it a second
		// time would destroy other users' new edits.
		later();
		expect(await resumeForgetJobs()).toMatchObject({ completed: 1 });
		expect(drop).toHaveBeenCalledTimes(1);
		expect(purgeUser).toHaveBeenCalledTimes(1);
		expect((await listForgetJobs())[0]).toMatchObject({ status: 'completed', attempts: 2, rowsAffected: 2 });
	});

	it('runs a surface again when it failed in the earlier run', async () => {
		let dlFailures = 1;
		const purgeUser = vi.fn(() => { if (dlFailures-- > 0) throw new Error('offline'); return 2; });
		configureWebhooks({ deadLetter: { add() { return null; }, purgeUser } });
		configureForget({ jobs: true });
		await expect(live.forget('alice', { tenantId: null })).rejects.toMatchObject({ code: 'FORGET_INCOMPLETE' });
		later();
		expect(await resumeForgetJobs()).toMatchObject({ completed: 1 });
		expect(purgeUser).toHaveBeenCalledTimes(2);
	});
});

describe('in-memory job store capacity', () => {
	it('makes room by dropping the oldest completed job and refuses a new job when only unfinished ones remain', async () => {
		const jobs = createForgetJobStore({ max: 2 });
		const purgeUser = vi.fn(async (_t, userId) => { if (userId !== 'carol') throw new Error('offline'); return 0; });
		configureForget({ store: { purgeUser }, jobs });
		const done = await live.forget('carol', { tenantId: null });
		await expect(live.forget('alice', { tenantId: null })).rejects.toMatchObject({ code: 'FORGET_STORE_FAILED' });
		// Full: the completed job makes room for the next one.
		await expect(live.forget('bob', { tenantId: null })).rejects.toMatchObject({ code: 'FORGET_STORE_FAILED' });
		expect((await listForgetJobs()).map((j) => j.id)).not.toContain(done.job);
		// Full of unfinished jobs: the erasure is refused before anything is erased.
		purgeUser.mockClear();
		await expect(live.forget('dave', { tenantId: null })).rejects.toMatchObject({ code: 'FORGET_JOB_FAILED' });
		expect(purgeUser).not.toHaveBeenCalled();
		expect(await listForgetJobs({ status: 'failed' })).toHaveLength(2);
	});

	it('holds 10000 jobs by default', () => {
		const s = createForgetJobStore();
		for (let i = 0; i < 10000; i++) s.begin({ id: 'j' + i, runId: 'r', userIdHash: 'h', tenantId: null, userId: 'u', cascade: true, at: i, leaseUntil: i + 1 });
		expect(() => s.begin({ id: 'over', runId: 'r', userIdHash: 'h', tenantId: null, userId: 'u', cascade: true, at: 0, leaseUntil: 1 })).toThrow(/full/);
	});
});

describe('erasure input and store bounds', () => {
	afterEach(() => configureWebhooks({ deadLetter: false }));

	/** Settles with the outcome, or 'hung' when nothing settles within `ms`. */
	const within = (p, ms = 2000) => Promise.race([
		p.then((v) => ({ value: v }), (e) => ({ error: e })),
		new Promise((r) => setTimeout(() => r('hung'), ms))
	]);

	it('validates the cascade a resume replays and records the job as failed', async () => {
		const jobs = createForgetJobStore();
		const purgeUser = vi.fn(async () => 0);
		configureForget({ store: partial(), jobs });
		await live.forget('alice', { tenantId: null }).catch(() => {});
		for (const cascade of [{ crdt: 'notes:1' }, 'yes', { crdt: [''] }]) {
			configureForget({ store: { purgeUser }, jobs: { ...jobs, claim: (r) => { const c = jobs.claim(r); return c && { ...c, cascade }; } } });
			const [job] = await listForgetJobs();
			const res = await resumeForgetJobs({ id: job.id });
			expect(res.results).toEqual([{ id: job.id, status: 'failed', code: 'INVALID_REQUEST' }]);
		}
		expect(purgeUser).not.toHaveBeenCalled();
		expect((await listForgetJobs())[0]).toMatchObject({ status: 'failed', error: { code: 'INVALID_REQUEST' } });
	});

	it('releases the lease of a stored job with an invalid tenant', async () => {
		const jobs = createForgetJobStore();
		configureForget({ store: partial(), jobs });
		await live.forget('alice', { tenantId: null }).catch(() => {});
		configureForget({ store: durable(), jobs: { ...jobs, claim: (r) => { const c = jobs.claim(r); return c && { ...c, tenantId: 'not a tenant!' }; } } });
		const [job] = await listForgetJobs();
		expect((await resumeForgetJobs({ id: job.id })).results).toEqual([{ id: job.id, status: 'failed', code: 'VALIDATION' }]);
		expect((await listForgetJobs())[0]).toMatchObject({ status: 'failed', attempts: 2, error: { code: 'VALIDATION' } });
		expect(rows.get('alice')).toBe(2);
	});

	it('waits for a slow durable store without a configured timeout', async () => {
		// Timers of 1 s or more fire after 10 ms, so a default bound would trip.
		setRuntimeEnv({ timers: { set: (cb, ms, ...a) => setTimeout(cb, ms >= 1000 ? 10 : ms, ...a) } });
		configureForget({ store: { purgeUser: () => new Promise((r) => setTimeout(() => r(2), 60)) } });
		await expect(live.forget('alice', { tenantId: null })).resolves.toMatchObject({ rowsAffected: 2 });
	});

	it('announces the owner changes of a durable purge that commits after its timeout', async () => {
		_resetReplayRouting();
		const published = [];
		const platform = { publish: (t, e, d) => published.push({ t, e, d }) };
		const late = { rowsAffected: 1, ownerSuccessions: [{ topic: 'board/1', owner: 'u2', reason: 'succeeded' }] };
		configureForget({ platform, timeoutMs: 20, store: { purgeUser: () => new Promise((r) => setTimeout(() => r(late), 60)) } });
		await expect(live.forget('u1', { tenantId: null })).rejects.toMatchObject({ code: 'FORGET_STORE_FAILED' });
		expect(published).toEqual([]);
		await vi.waitFor(() => expect(published).toContainEqual({ t: 'board/1:owner', e: 'set', d: { key: 'u2', reason: 'succeeded' } }));
		_resetReplayRouting();
	});

	it('announces the committed owner changes of a durable purge that fails after its timeout', async () => {
		_resetReplayRouting();
		const published = [];
		const platform = { publish: (t, e, d) => published.push({ t, e, d }) };
		const err = Object.assign(new Error('partial'), { ownerSuccessions: [{ topic: 'board/2', owner: null, reason: 'vacated' }] });
		configureForget({ platform, timeoutMs: 20, store: { purgeUser: () => new Promise((_r, j) => setTimeout(() => j(err), 60)) } });
		await expect(live.forget('u1', { tenantId: null })).rejects.toMatchObject({ code: 'FORGET_STORE_FAILED' });
		await vi.waitFor(() => expect(published).toContainEqual({ t: 'board/2:owner', e: 'set', d: { key: null, reason: 'vacated' } }));
		_resetReplayRouting();
	});

	it('bounds a durable store that never answers', async () => {
		configureForget({ store: { purgeUser: () => new Promise(() => {}) }, timeoutMs: 50 });
		const r = await within(live.forget('alice', { tenantId: null }));
		expect(r).not.toBe('hung');
		expect(r.error).toMatchObject({ code: 'FORGET_STORE_FAILED' });
	});

	it('bounds every surface on its own, so one hung surface does not starve the rest', async () => {
		configureWebhooks({ deadLetter: { add() { return null; }, purgeUser: () => new Promise(() => {}) } });
		configureForget({ store: durable(), jobs: true, timeoutMs: 50 });
		const r = await within(live.forget('alice', { tenantId: null }));
		expect(r.error).toMatchObject({ code: 'FORGET_INCOMPLETE' });
		expect(rows.has('alice')).toBe(false);
		expect((await listForgetJobs())[0]).toMatchObject({ status: 'failed', error: { failedSurfaces: ['webhookDeadLetter'] } });
	});

	it('bounds a job store that never answers', async () => {
		const purgeUser = vi.fn(async () => 0);
		const jobs = createForgetJobStore();
		configureForget({ store: { purgeUser }, jobs: { ...jobs, begin: () => new Promise(() => {}) }, timeoutMs: 50 });
		const r = await within(live.forget('alice', { tenantId: null }));
		expect(r.error).toMatchObject({ code: 'FORGET_JOB_FAILED' });
		expect(purgeUser).not.toHaveBeenCalled();
	});

	it('validates timeoutMs', () => {
		for (const timeoutMs of [0, -1, 1.5, '50', 600_001]) {
			expect(() => configureForget({ timeoutMs })).toThrow(/timeoutMs/);
		}
	});
});

describe('erasure jobs across processes', () => {
	afterEach(() => { resetRuntimeEnv(); vi.resetModules(); _crdtDecls.clear(); configureWebhooks({ deadLetter: false }); });

	/** Another process: its own module instance (own memory), the same job store. */
	async function otherProcess(jobs, store, { muchLater = false } = {}) {
		vi.resetModules();
		const other = await import('../src/server.js');
		if (muchLater) (await import('../src/shared/runtime.js')).setRuntimeEnv({ clock: { wallEpoch: () => Date.now() + 24 * 3_600_000 } });
		const crdt = await import('../src/server/crdt.js');
		const drop = vi.fn(() => true);
		crdt._crdtDecls.set('notes', { authority: { drop } });
		const purgeUser = vi.fn(() => 0);
		other.configureWebhooks({ deadLetter: { add() { return null; }, purgeUser } });
		const dl = other.createDeadLetterStore();
		const dlPurge = vi.spyOn(dl, 'purgeUser');
		other.configureWebhooks({ deadLetter: dl });
		other.configureForget({ store, jobs });
		return { other, drop, dlPurge };
	}

	it('leaves the in-memory steps of a live owner to that owner', async () => {
		const jobs = createForgetJobStore();
		let failures = 1;
		const dl = createDeadLetterStore();
		const purge = vi.spyOn(dl, 'purgeUser').mockImplementation(() => { if (failures-- > 0) throw new Error('offline'); return 0; });
		configureWebhooks({ deadLetter: dl });
		configureForget({ store: durable(), jobs });
		const err = await live.forget('alice', { tenantId: null }).catch((e) => e);
		expect(err.code).toBe('FORGET_INCOMPLETE');

		const b = await otherProcess(jobs, durable());
		expect(await b.other.resumeForgetJobs()).toMatchObject({ total: 0 });
		expect(await b.other.resumeForgetJobs({ id: err.job })).toMatchObject({ results: [{ id: err.job, status: 'skipped' }] });
		expect(b.dlPurge).not.toHaveBeenCalled();
		expect((await listForgetJobs())[0].status).toBe('failed');

		// The owner finishes its own step.
		expect(await resumeForgetJobs({ id: err.job })).toMatchObject({ completed: 1 });
		expect(purge).toHaveBeenCalledTimes(2);
		b.other.configureForget(null);
	});

	it('completes the job of an owner that is gone without running its in-memory steps elsewhere', async () => {
		const jobs = createForgetJobStore();
		const dl = createDeadLetterStore();
		vi.spyOn(dl, 'purgeUser').mockImplementation(() => { throw new Error('offline'); });
		configureWebhooks({ deadLetter: dl });
		configureForget({ store: partial(), jobs });
		const err = await live.forget('alice', { tenantId: null }).catch((e) => e);
		configureForget(null); // this process stops beating

		// A day later the owner's liveness has long lapsed.
		const b = await otherProcess(jobs, durable(), { muchLater: true });
		expect(await b.other.resumeForgetJobs()).toMatchObject({ completed: 1, results: [{ id: err.job, status: 'completed' }] });
		expect(b.dlPurge).not.toHaveBeenCalled();
		expect(rows.has('alice')).toBe(false);
		b.other.configureForget(null);
	});

	it('runs only the open shared step when another process resumes, and never repeats a finished document drop', async () => {
		const jobs = createForgetJobStore();
		const drop = vi.fn(() => true);
		_crdtDecls.set('notes', { authority: { drop } });
		configureForget({ store: partial(), jobs });
		const err = await live.forget('alice', { tenantId: null, cascade: { crdt: ['notes:1'] } }).catch((e) => e);
		expect(err.code).toBe('FORGET_STORE_FAILED');
		expect(drop).toHaveBeenCalledTimes(1);

		// B takes the open durable step; A is alive and has nothing left.
		const b = await otherProcess(jobs, durable());
		expect(await b.other.resumeForgetJobs({ id: err.job })).toMatchObject({ completed: 1 });
		expect(b.drop).not.toHaveBeenCalled();
		expect(drop).toHaveBeenCalledTimes(1);
		b.other.configureForget(null);
	});

	it('does not repeat a document drop whose outcome the store never recorded', async () => {
		const jobs = createForgetJobStore();
		const drop = vi.fn(() => true);
		_crdtDecls.set('notes', { authority: { drop } });
		configureForget({ store: partial(), jobs: { ...jobs, fail() { throw new Error('job store offline'); } } });
		const err = await live.forget('alice', { tenantId: null, cascade: { crdt: ['notes:1'] } }).catch((e) => e);
		expect(err.code).toBe('FORGET_STORE_FAILED');

		// The same process resumes its own job: the drop it remembers is not repeated.
		configureForget({ store: durable(), jobs });
		expect(await resumeForgetJobs({ id: err.job })).toMatchObject({ completed: 1 });
		expect(drop).toHaveBeenCalledTimes(1);
	});

	it('beats while a job store is configured', async () => {
		const jobs = createForgetJobStore();
		const beat = vi.spyOn(jobs, 'beat');
		configureForget({ jobs });
		await vi.waitFor(() => expect(beat).toHaveBeenCalledWith(expect.objectContaining({ processId: expect.any(String) })));
	});
});

describe('jobs that cannot finish', () => {
	afterEach(() => configureWebhooks({ deadLetter: false }));
	// A dead-letter store without purgeUser fails its surface on every run.
	const brokenDeadLetter = () => configureWebhooks({ deadLetter: { add() { return null; } } });

	it('stops retrying after a bounded number of attempts, reports it and keeps it listed', async () => {
		brokenDeadLetter();
		configureForget({ jobs: true });
		const err = await live.forget('alice', { tenantId: null }).catch((e) => e);
		for (let i = 1; i < 24; i++) await resumeForgetJobs({ id: err.job });
		const [job] = await listForgetJobs({ status: 'exhausted' });
		expect(job).toMatchObject({ id: err.job, attempts: 24, retryAt: null, error: { code: 'FORGET_INCOMPLETE', failedSurfaces: ['webhookDeadLetter'] } });
		expect(events.filter((e) => e.event === 'forget.job-exhausted').map((e) => e.attributes)).toEqual([{ job: err.job, code: 'FORGET_INCOMPLETE', attempts: 24 }]);
		later();
		expect(await resumeForgetJobs()).toMatchObject({ total: 0 });
		// An operator who fixed the cause runs it by id.
		configureWebhooks({ deadLetter: { add() { return null; }, purgeUser: () => 0 } });
		expect(await resumeForgetJobs({ id: err.job })).toMatchObject({ completed: 1 });
	});

	it('does not let exhausted jobs block new erasures in the in-memory store', async () => {
		brokenDeadLetter();
		const jobs = createForgetJobStore({ max: 1 });
		configureForget({ jobs });
		const err = await live.forget('alice', { tenantId: null }).catch((e) => e);
		for (let i = 1; i < 24; i++) await resumeForgetJobs({ id: err.job });
		configureWebhooks({ deadLetter: false });
		await expect(live.forget('bob', { tenantId: null })).resolves.toMatchObject({ ok: true });
	});

	it('abandons an unfinished job on request', async () => {
		brokenDeadLetter();
		configureForget({ jobs: true });
		const err = await live.forget('alice', { tenantId: null }).catch((e) => e);
		expect(await abandonForgetJob(err.job)).toBe(true);
		expect(await abandonForgetJob(err.job)).toBe(false);
		expect(await abandonForgetJob('unknown')).toBe(false);
		const [job] = await listForgetJobs({ status: 'abandoned' });
		expect(job.id).toBe(err.job);
		later();
		expect(await resumeForgetJobs()).toMatchObject({ total: 0 });
		expect(await resumeForgetJobs({ id: err.job })).toMatchObject({ results: [{ status: 'skipped' }] });
		const done = await (configureWebhooks({ deadLetter: false }), live.forget('bob', { tenantId: null }));
		expect(await abandonForgetJob(done.job)).toBe(false);
		await expect(abandonForgetJob('')).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
	});
});
