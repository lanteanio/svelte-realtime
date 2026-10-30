// Erasure jobs: with a job store configured, live.forget records the erasure
// before touching any surface, keeps it pending until every surface confirms,
// and records the outcome against a pseudonymous reference. A process that dies
// part-way leaves a pending job that a later process resumes with the same store.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash, createHmac } from 'node:crypto';
import {
	live, configureForget, configureWebhooks, createForgetJobStore, listForgetJobs, resumeForgetJobs,
	_resetForget, setOperationalEventSink
} from '../src/server.js';
import { _pushRegistry } from '../src/server/push.js';
import { _crdtDecls } from '../src/server/crdt.js';
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
			id, userIdHash: hmac(user), tenantId: 'acme', status: 'failed', attempts: 1,
			createdAt: expect.any(Number), updatedAt: expect.any(Number), completedAt: null, retryAt: expect.any(Number), rowsAffected: null,
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
		// Its run still holds the lease until it expires.
		expect(await resumeForgetJobs()).toMatchObject({ total: 0 });
		later();
		expect(await resumeForgetJobs()).toMatchObject({ completed: 1 });
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
	const intent = (over = {}) => ({ id: 'j1', runId: 'r1', userIdHash: 'h', tenantId: null, userId: 'alice', cascade: { crdt: ['doc'] }, at: 10, leaseUntil: 100, ...over });
	const claim = (over = {}) => ({ id: 'j1', runId: 'r2', at: 100, leaseUntil: 200, ...over });

	it('leases a job to one run at a time and fences outcomes of other runs', () => {
		const s = createForgetJobStore();
		const cascade = { crdt: ['doc'] };
		s.begin(intent({ cascade }));
		cascade.crdt.push('mutated');
		expect(() => s.begin(intent())).toThrow();
		// The first run holds the lease until 100.
		expect(s.claim(claim({ at: 99 }))).toBeNull();
		expect(s.due({ at: 99, limit: 10 })).toEqual([]);
		expect(s.due({ at: 100, limit: 10 }).map((j) => j.id)).toEqual(['j1']);
		// Its lease expired: another run takes over and the late run is fenced.
		expect(s.claim(claim())).toEqual({ userId: 'alice', userIdHash: 'h', tenantId: null, cascade: { crdt: ['doc'] }, attempts: 2, doneSurfaces: [] });
		expect(s.complete({ id: 'j1', runId: 'r1', at: 150, rowsAffected: 1, surfaces: {} })).toBe(false);
		expect(s.fail({ id: 'j1', runId: 'r1', at: 150, code: 'X', failedSurfaces: [], retryAt: 151 })).toBe(false);
		expect(s.list()[0]).toMatchObject({ status: 'pending', attempts: 2, createdAt: 10, updatedAt: 100 });
		expect(s.fail({ id: 'j1', runId: 'r2', at: 160, code: 'FORGET_INCOMPLETE', failedSurfaces: ['presence'], doneSurfaces: ['push', 'crdtDocs'], retryAt: 300 })).toBe(true);
		expect(s.list({ status: 'failed' })[0]).toMatchObject({ retryAt: 300, error: { code: 'FORGET_INCOMPLETE', failedSurfaces: ['presence'] } });
		expect(s.due({ at: 299, limit: 10 })).toEqual([]);
		// A failed job is claimable by id before its retry time.
		expect(s.claim(claim({ runId: 'r3', at: 170, leaseUntil: 400 }))).toMatchObject({ attempts: 3, doneSurfaces: ['push', 'crdtDocs'] });
		expect(s.fail({ id: 'j1', runId: 'r3', at: 175, code: 'X', failedSurfaces: ['presence'], doneSurfaces: ['push', 'durable'], retryAt: 176 })).toBe(true);
		expect(s.claim(claim({ runId: 'r3', at: 177, leaseUntil: 400 }))).toMatchObject({ attempts: 4, doneSurfaces: ['push', 'crdtDocs', 'durable'] });
		expect(s.complete({ id: 'j1', runId: 'r3', at: 180, rowsAffected: 2, surfaces: {} })).toBe(true);
		expect(s.list()[0]).toMatchObject({ status: 'completed', attempts: 4, completedAt: 180, retryAt: null, rowsAffected: 2, error: null });
		expect(s.claim(claim({ runId: 'r4', at: 1000, leaseUntil: 2000 }))).toBeNull();
		expect(JSON.stringify(s.list())).not.toContain('alice');
	});

	it('orders due jobs by how long they have been due', () => {
		const s = createForgetJobStore();
		s.begin(intent({ id: 'a', at: 1, leaseUntil: 50 }));
		s.begin(intent({ id: 'b', at: 2, leaseUntil: 20 }));
		s.begin(intent({ id: 'c', at: 3, leaseUntil: 500 }));
		expect(s.due({ at: 100, limit: 10 }).map((j) => j.id)).toEqual(['b', 'a']);
		expect(s.due({ at: 100, limit: 1 }).map((j) => j.id)).toEqual(['b']);
	});

	it('lists oldest first and bounds retained completed jobs, never pending ones', () => {
		const s = createForgetJobStore({ max: 2 });
		for (let i = 0; i < 4; i++) {
			s.begin(intent({ id: 'c' + i, runId: 'r', at: i }));
			s.complete({ id: 'c' + i, runId: 'r', at: i, rowsAffected: 0, surfaces: {} });
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
		expect((await listForgetJobs())[0]).toMatchObject({ status: 'completed', attempts: 2, rowsAffected: 1 });
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
