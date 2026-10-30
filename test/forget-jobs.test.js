// Erasure jobs: with a job store configured, live.forget records the erasure
// before touching any surface and tracks its shared steps (the durable store, a
// shared dead-letter store) in the store, where any process can finish them
// under a lease. In-memory steps stay with the process that ran live.forget,
// which retries them itself; a process that exits takes that memory with it.

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
import { __registerAggregate, _activateDerived, _resetAggregates } from '../src/server.js';
import { aggregateRegistry } from '../src/server/state.js';
import { mockPlatform } from './helpers/mock-platform.js';

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
/** A built-in (in-memory, per-process) dead-letter store whose purge fails `times` times. */
function flakyMemoryDeadLetter(times) {
	const dl = createDeadLetterStore();
	let left = times;
	const purge = vi.spyOn(dl, 'purgeUser').mockImplementation(() => { if (left-- > 0) throw new Error('offline'); return 0; });
	configureWebhooks({ deadLetter: dl });
	return purge;
}

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
	_crdtDecls.clear();
	configureWebhooks({ deadLetter: false });
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
		later(); // the dead run's lease has expired
		const pending = await listForgetJobs({ status: 'pending' });
		expect(pending).toHaveLength(1);
		expect(pending[0]).toMatchObject({ userIdHash: sha('alice'), tenantId: null, attempts: 1, local: null });
		expect(JSON.stringify(pending)).not.toContain('alice');

		const onForget = vi.fn();
		const res = await resumeForgetJobs({ onForget });
		expect(res).toEqual({ total: 1, completed: 1, failed: 0, results: [{ id: pending[0].id, steps: 'shared', status: 'completed' }] });
		expect(rows.has('alice')).toBe(false);
		expect(rows.get('bob')).toBe(2);
		expect(onForget).toHaveBeenCalledWith(expect.objectContaining({ userIdHash: sha('alice'), tenantId: null, rowsAffected: 2 }));
		const [done] = await listForgetJobs();
		expect(done).toMatchObject({ status: 'completed', attempts: 2, rowsAffected: 2, error: null, userIdHash: null });
		expect(typeof done.completedAt).toBe('number');
		expect(await jobs.claim({ id: done.id, runId: 'r', leaseMs: 1000, exhausted: true })).toBeNull();
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
			createdAt: expect.any(Number), updatedAt: expect.any(Number), completedAt: null, retryAt: expect.any(Number), rowsAffected: 0,
			error: { code: 'FORGET_STORE_FAILED', failedSurfaces: ['durable'] }, local: null
		}]);
		const incomplete = events.filter((e) => e.event === 'forget.incomplete');
		expect(incomplete).toHaveLength(1);
		expect(incomplete[0].attributes).toMatchObject({ job: id, failedSurfaces: ['durable'] });
		expect(JSON.stringify([failed, events])).not.toContain('alice');

		// The store recovers; resuming the failed job completes it.
		configureForget({ store: durable() });
		expect(await resumeForgetJobs({ id })).toMatchObject({ completed: 1, results: [{ id, steps: 'shared', status: 'completed' }] });
		expect((await listForgetJobs())[0]).toMatchObject({ status: 'completed', attempts: 2, error: null });
	});

	it('keeps a job failed when the resumed run fails again', async () => {
		configureForget({ store: partial(), jobs: true });
		await expect(live.forget('alice', { tenantId: null })).rejects.toMatchObject({ code: 'FORGET_STORE_FAILED' });
		later();
		const res = await resumeForgetJobs();
		expect(res).toMatchObject({ total: 1, completed: 0, failed: 1, results: [{ steps: 'shared', status: 'failed', code: 'FORGET_STORE_FAILED' }] });
		expect((await listForgetJobs({ status: 'failed' }))[0].attempts).toBe(2);
	});

	it('erases nothing when the intent cannot be recorded', async () => {
		const purgeUser = vi.fn(async () => 1);
		const jobs = createForgetJobStore();
		configureForget({ store: { purgeUser }, jobs: { ...jobs, begin() { throw new Error('job store offline'); } } });
		await expect(live.forget('alice', { tenantId: null })).rejects.toMatchObject({ code: 'FORGET_JOB_FAILED' });
		expect(purgeUser).not.toHaveBeenCalled();
	});

	it('requires a tenant scope once a job store is configured', async () => {
		configureForget({ jobs: true });
		await expect(live.forget('alice')).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
		expect(await listForgetJobs()).toEqual([]);
	});

	it('is inert without a job store', async () => {
		expect(await listForgetJobs()).toEqual([]);
		expect(await resumeForgetJobs()).toEqual({ total: 0, completed: 0, failed: 0, results: [] });
		expect(await abandonForgetJob('x')).toBe(false);
		const res = await live.forget('alice');
		expect(res).not.toHaveProperty('job');
	});

	it('validates configuration and options', async () => {
		expect(() => configureForget({ jobs: { begin() {} } })).toThrow(/jobs/);
		for (const resumeIntervalMs of [0, 999, 1.5, '5000', 86_400_001]) {
			expect(() => configureForget({ resumeIntervalMs })).toThrow(/resumeIntervalMs/);
		}
		await expect(listForgetJobs({ status: 'done' })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
		await expect(listForgetJobs({ limit: 0 })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
		await expect(resumeForgetJobs({ limit: 1001 })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
		await expect(resumeForgetJobs({ id: 7 })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
		await expect(resumeForgetJobs({ onForget: 'x' })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
		await expect(resumeForgetJobs({ exhausted: 'yes' })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
		await expect(abandonForgetJob('')).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
	});
});

describe('createForgetJobStore', () => {
	const intent = (over = {}) => ({
		id: 'j1', runId: 'r1', leaseMs: 100, userIdHash: 'h', tenantId: null, userId: 'alice',
		cascade: { crdt: ['doc'] }, shared: ['webhookDeadLetter', 'durable'], ...over
	});
	const fail = (over = {}) => ({ id: 'j1', runId: 'r1', code: 'FORGET_STORE_FAILED', failedSurfaces: ['durable'], sharedDone: ['webhookDeadLetter'], rowsAffected: 2, retryAfterMs: 30, exhausted: false, ...over });
	let t;
	beforeEach(() => { t = 1000; setRuntimeEnv({ clock: { wallEpoch: () => t } }); });

	it('leases a job by the store clock, renews it, and fences outcomes of other runs', () => {
		const s = createForgetJobStore();
		const cascade = { crdt: ['doc'] };
		s.begin(intent({ cascade }));
		cascade.crdt.push('mutated');
		expect(() => s.begin(intent())).toThrow();
		expect(s.claim({ id: 'j1', runId: 'r2', leaseMs: 100 })).toBeNull();
		t = 1050;
		expect(s.renew({ id: 'j1', runId: 'r1', leaseMs: 100 })).toBe(true);
		t = 1120;
		expect(s.claim({ id: 'j1', runId: 'r2', leaseMs: 100 })).toBeNull();
		expect(s.due({ limit: 10 })).toEqual([]);
		// The run stopped renewing: its lease runs out and another run takes over.
		t = 1150;
		expect(s.due({ limit: 10 }).map((j) => j.id)).toEqual(['j1']);
		expect(s.claim({ id: 'j1', runId: 'r2', leaseMs: 100 })).toEqual({
			userId: 'alice', userIdHash: 'h', tenantId: null, cascade: { crdt: ['doc'] }, attempts: 2, shared: ['webhookDeadLetter', 'durable']
		});
		expect(s.renew({ id: 'j1', runId: 'r1', leaseMs: 100 })).toBe(false);
		expect(s.complete({ id: 'j1', runId: 'r1', rowsAffected: 1 })).toBe(false);
		expect(s.fail(fail())).toBe(false);
		expect(s.fail(fail({ runId: 'r2' }))).toBe(true);
		expect(s.list({ status: 'failed' })[0]).toMatchObject({ retryAt: 1180, rowsAffected: 2, error: { code: 'FORGET_STORE_FAILED', failedSurfaces: ['durable'] } });
		expect(s.due({ limit: 10 })).toEqual([]);
		t = 1180;
		expect(s.claim({ id: 'j1', runId: 'r3', leaseMs: 100 })).toMatchObject({ shared: ['durable'], attempts: 3 });
		expect(s.complete({ id: 'j1', runId: 'r3', rowsAffected: 1 })).toBe(true);
		expect(s.list()[0]).toMatchObject({ status: 'completed', completedAt: 1180, retryAt: null, rowsAffected: 3, error: null, userIdHash: null });
		expect(s.claim({ id: 'j1', runId: 'r4', leaseMs: 100, exhausted: true })).toBeNull();
		expect(JSON.stringify(s.list())).not.toContain('alice');
	});

	it('keeps exhausted jobs out of due and claims them only on request', () => {
		const s = createForgetJobStore();
		s.begin(intent());
		expect(s.fail(fail({ exhausted: true }))).toBe(true);
		expect(s.list()[0]).toMatchObject({ status: 'exhausted', retryAt: null });
		t = 1e9;
		expect(s.due({ limit: 10 })).toEqual([]);
		expect(s.claim({ id: 'j1', runId: 'r2', leaseMs: 100 })).toBeNull();
		expect(s.due({ limit: 10, exhausted: true }).map((j) => j.id)).toEqual(['j1']);
		expect(s.claim({ id: 'j1', runId: 'r2', leaseMs: 100, exhausted: true })).toMatchObject({ attempts: 2 });
	});

	it('abandons only a job no live lease holds, unless the holder asks', () => {
		const s = createForgetJobStore();
		s.begin(intent());
		expect(s.abandon({ id: 'j1' })).toBe(false);
		expect(s.abandon({ id: 'j1', runId: 'r1' })).toBe(true);
		expect(s.list()[0]).toMatchObject({ status: 'abandoned', userIdHash: null });
		expect(s.abandon({ id: 'j1', runId: 'r1' })).toBe(false);
		expect(s.claim({ id: 'j1', runId: 'r2', leaseMs: 100, exhausted: true })).toBeNull();
	});

	it('orders due jobs by how long they have been due', () => {
		const s = createForgetJobStore();
		for (const [id, delay] of [['a', 50], ['b', 20], ['c', 500]]) {
			s.begin(intent({ id }));
			s.fail(fail({ id, retryAfterMs: delay }));
		}
		t = 1100;
		expect(s.due({ limit: 10 }).map((j) => j.id)).toEqual(['b', 'a']);
		expect(s.due({ limit: 1 }).map((j) => j.id)).toEqual(['b']);
	});

	it('lists oldest first and drops the oldest completion to stay within max', () => {
		const s = createForgetJobStore({ max: 3 });
		for (let i = 0; i < 4; i++) {
			t = 1001 + i;
			s.begin(intent({ id: 'c' + i, runId: 'r' }));
			s.complete({ id: 'c' + i, runId: 'r', rowsAffected: 0 });
		}
		t = 2000;
		s.begin(intent({ id: 'p', runId: 'r' }));
		expect(s.list().map((j) => j.id)).toEqual(['c2', 'c3', 'p']);
		expect(s.list({ limit: 1 }).map((j) => j.id)).toEqual(['c2']);
	});
});

describe('erasure job identity', () => {
	it('gives every call its own job, so a failed run is not hidden by a concurrent success', async () => {
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

describe('shared steps across processes', () => {
	afterEach(() => { vi.resetModules(); });

	it('lets only one process run a job at a time', async () => {
		const jobs = createForgetJobStore();
		configureForget({ store: partial(), jobs });
		await expect(live.forget('alice', { tenantId: null })).rejects.toMatchObject({ code: 'FORGET_STORE_FAILED' });
		setRuntimeEnv({ clock: { wallEpoch: () => Date.now() + 3_600_000 } }); // past any retry delay

		vi.resetModules();
		const other = await import('../src/server.js');
		(await import('../src/shared/runtime.js')).setRuntimeEnv({ clock: { wallEpoch: () => Date.now() + 3_600_000 } });
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
			{ total: 1, completed: 0, failed: 0, results: [{ id: held.id, steps: 'shared', status: 'skipped' }] }
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

		expect(await resumeForgetJobs()).toMatchObject({ total: 0 });
		const [alice, bob] = await listForgetJobs({ status: 'failed' });
		expect(alice.retryAt).toBeGreaterThan(t);

		t += 60_000;
		expect((await resumeForgetJobs({ limit: 1 })).results).toEqual([{ id: alice.id, steps: 'shared', status: 'failed', code: 'FORGET_STORE_FAILED' }]);
		t += 1;
		expect((await resumeForgetJobs({ limit: 1 })).results).toEqual([{ id: bob.id, steps: 'shared', status: 'completed' }]);
		const after = (await listForgetJobs({ status: 'failed' }))[0];
		expect(after).toMatchObject({ id: alice.id, attempts: 2 });
		expect(after.retryAt - after.updatedAt).toBeGreaterThan(alice.retryAt - alice.updatedAt);
	});

	it('keeps a long run on its job while it runs, so a resume elsewhere never starts a second run', async () => {
		let wall = 0;
		let mono = 0;
		setRuntimeEnv({
			clock: { wallEpoch: () => Date.now() + wall, monotonic: () => performance.now() + mono },
			timers: { setInterval: (cb, _ms, ...a) => setInterval(cb, 5, ...a) }
		});
		const jobs = createForgetJobStore();
		const complete = vi.spyOn(jobs, 'complete');
		let release;
		let purges = 0;
		const slow = { purgeUser: () => { purges++; return new Promise((r) => { release = r; }); } };
		configureForget({ store: slow, jobs });
		const run = live.forget('alice', { tenantId: null });
		await vi.waitFor(() => expect(purges).toBe(1));

		// Another process resumes on an interval with the same store.
		vi.resetModules();
		const other = await import('../src/server.js');
		(await import('../src/shared/runtime.js')).setRuntimeEnv({ timers: { setInterval: (cb, _ms, ...a) => setInterval(cb, 5, ...a) } });
		other.configureForget({ store: slow, jobs, resumeIntervalMs: 1000 });

		// The run goes on for 40 minutes, the clocks moving 30 s at a time; its
		// renewals keep the lease ahead of the store clock throughout.
		for (let step = 1; step <= 80; step++) {
			wall = mono = step * 30_000;
			await new Promise((r) => setTimeout(r, 12));
		}
		expect(purges).toBe(1);
		const overdue = events.filter((e) => e.event === 'forget.run-overdue');
		expect(overdue.length).toBe(2);
		release(1);
		await expect(run).resolves.toMatchObject({ ok: true });
		expect(complete).toHaveReturnedWith(true);
		expect((await listForgetJobs())[0]).toMatchObject({ status: 'completed', attempts: 1 });
		other.configureForget(null);
	});

	it('keeps one renewal in flight when renew hangs', async () => {
		setRuntimeEnv({ timers: { setInterval: (cb, _ms, ...a) => setInterval(cb, 5, ...a) } });
		const jobs = createForgetJobStore();
		let renews = 0;
		let release;
		configureForget({ store: { purgeUser: () => new Promise((r) => { release = r; }) }, jobs: { ...jobs, renew: () => { renews++; return new Promise(() => {}); } } });
		const run = live.forget('alice', { tenantId: null });
		await new Promise((r) => setTimeout(r, 60));
		expect(renews).toBe(1);
		release(0);
		await run;
	});
});

describe('resuming a partly finished erasure', () => {
	it('runs only the open shared steps and never repeats a finished document drop', async () => {
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

		later();
		expect(await resumeForgetJobs()).toMatchObject({ completed: 1 });
		expect(drop).toHaveBeenCalledTimes(1);
		expect(purgeUser).toHaveBeenCalledTimes(1);
		expect((await listForgetJobs())[0]).toMatchObject({ status: 'completed', attempts: 2, rowsAffected: 2 });
	});

	it('runs a shared step again when it failed in the earlier run', async () => {
		let dlFailures = 1;
		const purgeUser = vi.fn(() => { if (dlFailures-- > 0) throw new Error('offline'); return 2; });
		configureWebhooks({ deadLetter: { add() { return null; }, purgeUser } });
		configureForget({ jobs: true });
		await expect(live.forget('alice', { tenantId: null })).rejects.toMatchObject({ code: 'FORGET_INCOMPLETE' });
		later();
		expect(await resumeForgetJobs()).toMatchObject({ completed: 1 });
		expect(purgeUser).toHaveBeenCalledTimes(2);
	});

	it('does not re-run in-memory steps when the completion was never recorded', async () => {
		const drop = vi.fn(() => true);
		_crdtDecls.set('notes', { authority: { drop } });
		const jobs = createForgetJobStore();
		configureForget({ store: durable(), jobs: { ...jobs, complete() { throw new Error('job store offline'); } } });
		await expect(live.forget('alice', { tenantId: null, cascade: { crdt: ['notes:1'] } })).resolves.toMatchObject({ ok: true, rowsAffected: 4 });
		expect(events.filter((e) => e.event === 'forget.job-unrecorded')).toHaveLength(1);
		expect((await listForgetJobs())[0]).toMatchObject({ status: 'pending', local: null });

		configureForget({ jobs });
		later(); // the run's lease has expired
		expect(await resumeForgetJobs()).toMatchObject({ completed: 1 });
		expect(drop).toHaveBeenCalledTimes(1);
	});
});

describe('in-memory steps stay with their process', () => {
	afterEach(() => { vi.resetModules(); });

	it('keeps a failed in-memory step in this process, shows it, and retries it here only', async () => {
		const purge = flakyMemoryDeadLetter(1);
		const sharedJobs = createForgetJobStore();
		configureForget({ store: durable(), jobs: sharedJobs });
		const err = await live.forget('alice', { tenantId: null }).catch((e) => e);
		expect(err.code).toBe('FORGET_INCOMPLETE');
		// The shared steps are done, so the job is complete in the store; this
		// process still owes its own in-memory step and says so.
		const [job] = await listForgetJobs();
		expect(job).toMatchObject({ id: err.job, status: 'completed', local: { open: ['webhookDeadLetter'], blocked: [], attempts: 1, exhausted: false } });

		// Another process cannot do it and does not try.
		vi.resetModules();
		const other = await import('../src/server.js');
		other.configureForget({ store: durable(), jobs: sharedJobs });
		expect(await other.resumeForgetJobs({ id: err.job })).toMatchObject({ results: [{ steps: 'shared', status: 'skipped' }] });
		expect(purge).toHaveBeenCalledTimes(1);
		other.configureForget(null);

		later();
		expect(await resumeForgetJobs()).toMatchObject({ completed: 1, results: [{ id: err.job, steps: 'local', status: 'completed' }] });
		expect(purge).toHaveBeenCalledTimes(2);
		expect((await listForgetJobs())[0].local).toBeNull();
	});

	it('retries its own in-memory steps on its own schedule', async () => {
		let offset = 0;
		setRuntimeEnv({
			clock: { wallEpoch: () => Date.now() + offset },
			timers: { set: (cb, _ms, ...a) => setTimeout(cb, 20, ...a) }
		});
		const purge = flakyMemoryDeadLetter(1);
		configureForget({ jobs: true });
		await live.forget('alice', { tenantId: null }).catch(() => {});
		offset = 2000; // the retry is due when the armed timer fires
		await vi.waitFor(() => expect(purge).toHaveBeenCalledTimes(2));
		expect((await listForgetJobs())[0].local).toBeNull();
	});

	it('reports in-memory steps that keep failing and stops retrying them', async () => {
		flakyMemoryDeadLetter(Infinity);
		configureForget({ jobs: true });
		const err = await live.forget('alice', { tenantId: null }).catch((e) => e);
		for (let i = 1; i < 24; i++) await resumeForgetJobs({ id: err.job });
		expect(events.filter((e) => e.event === 'forget.local-exhausted').map((e) => e.attributes)).toEqual([{ job: err.job, attempts: 24, reason: 'attempts' }]);
		expect((await listForgetJobs())[0].local).toMatchObject({ exhausted: true, retryAt: null });
		later();
		expect(await resumeForgetJobs()).toMatchObject({ total: 0 });
		// Fixed: a bulk resume of exhausted work runs it again.
		flakyMemoryDeadLetter(0);
		expect(await resumeForgetJobs({ exhausted: true })).toMatchObject({ completed: 1, results: [{ steps: 'local', status: 'completed' }] });
	});

	it('drops the in-memory steps it owes when the job is abandoned', async () => {
		const purge = flakyMemoryDeadLetter(Infinity);
		configureForget({ jobs: true });
		const err = await live.forget('alice', { tenantId: null }).catch((e) => e);
		expect(await abandonForgetJob(err.job)).toBe(true);
		expect((await listForgetJobs())[0].local).toBeNull();
		later();
		await resumeForgetJobs();
		expect(purge).toHaveBeenCalledTimes(1);
	});
});

describe('in-memory job store capacity', () => {
	it('makes room by dropping the oldest completed job and refuses a new job when only open ones remain', async () => {
		const jobs = createForgetJobStore({ max: 2 });
		const purgeUser = vi.fn(async (_t, userId) => { if (userId !== 'carol') throw new Error('offline'); return 0; });
		configureForget({ store: { purgeUser }, jobs });
		const done = await live.forget('carol', { tenantId: null });
		await expect(live.forget('alice', { tenantId: null })).rejects.toMatchObject({ code: 'FORGET_STORE_FAILED' });
		await expect(live.forget('bob', { tenantId: null })).rejects.toMatchObject({ code: 'FORGET_STORE_FAILED' });
		expect((await listForgetJobs()).map((j) => j.id)).not.toContain(done.job);
		purgeUser.mockClear();
		await expect(live.forget('dave', { tenantId: null })).rejects.toMatchObject({ code: 'FORGET_JOB_FAILED' });
		expect(purgeUser).not.toHaveBeenCalled();
		expect(await listForgetJobs({ status: 'failed' })).toHaveLength(2);
	});

	it('holds 10000 jobs by default', () => {
		const s = createForgetJobStore();
		const intent = (id) => ({ id, runId: 'r', leaseMs: 1, userIdHash: 'h', tenantId: null, userId: 'u', cascade: true, shared: [] });
		for (let i = 0; i < 10000; i++) s.begin(intent('j' + i));
		expect(() => s.begin(intent('over'))).toThrow(/full/);
	});
});

describe('erasure input and store bounds', () => {
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
			expect(res.results).toEqual([{ id: job.id, steps: 'shared', status: 'failed', code: 'INVALID_REQUEST' }]);
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
		expect((await resumeForgetJobs({ id: job.id })).results).toEqual([{ id: job.id, steps: 'shared', status: 'failed', code: 'VALIDATION' }]);
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

describe('jobs that cannot finish', () => {
	// A shared dead-letter store without purgeUser fails its step on every run.
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
		// An operator who fixed the cause resumes every exhausted job at once.
		configureWebhooks({ deadLetter: { add() { return null; }, purgeUser: () => 0 } });
		expect(await resumeForgetJobs({ exhausted: true })).toMatchObject({ completed: 1, results: [{ id: err.job, steps: 'shared', status: 'completed' }] });
	});

	it('does not let exhausted jobs block new erasures in the in-memory store, and reports the one it drops', async () => {
		brokenDeadLetter();
		const jobs = createForgetJobStore({ max: 1 });
		configureForget({ jobs });
		const err = await live.forget('alice', { tenantId: null }).catch((e) => e);
		for (let i = 1; i < 24; i++) await resumeForgetJobs({ id: err.job });
		configureWebhooks({ deadLetter: false });
		await expect(live.forget('bob', { tenantId: null })).resolves.toMatchObject({ ok: true });
		expect(events.filter((e) => e.event === 'forget.job-evicted').map((e) => e.attributes)).toEqual([{ job: err.job }]);
	});

	it('abandons an open job on request', async () => {
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
		expect(await resumeForgetJobs({ id: err.job })).toMatchObject({ results: [{ steps: 'shared', status: 'skipped' }] });
		configureWebhooks({ deadLetter: false });
		const done = await live.forget('bob', { tenantId: null });
		expect(await abandonForgetJob(done.job)).toBe(false);
	});
});

describe('erasure job retention', () => {
	it('keeps no user-derived field once a job is completed or abandoned', async () => {
		configureForget({ store: durable(), jobs: true });
		const done = await live.forget('alice', { tenantId: null });
		configureWebhooks({ deadLetter: { add() { return null; } } });
		const err = await live.forget('bob', { tenantId: null }).catch((e) => e);
		expect((await listForgetJobs({ status: 'failed' }))[0].userIdHash).toBe(sha('bob'));
		await abandonForgetJob(err.job);
		const byId = Object.fromEntries((await listForgetJobs()).map((j) => [j.id, j]));
		expect(byId[done.job]).toMatchObject({ status: 'completed', userIdHash: null });
		expect(byId[err.job]).toMatchObject({ status: 'abandoned', userIdHash: null });
	});
});

describe('a refused erasure', () => {
	it('never runs later when its job record lands after the call timed out', async () => {
		const jobs = createForgetJobStore();
		const purgeUser = vi.fn(async () => 1);
		const slowBegin = (intent) => new Promise((r) => setTimeout(() => r(jobs.begin(intent)), 60));
		configureForget({ store: { purgeUser }, jobs: { ...jobs, begin: slowBegin }, timeoutMs: 20 });
		const err = await live.forget('alice', { tenantId: null }).catch((e) => e);
		expect(err.code).toBe('FORGET_JOB_FAILED');
		await vi.waitFor(async () => expect((await listForgetJobs())[0]).toMatchObject({ id: err.job, status: 'abandoned', userIdHash: null }));
		later();
		expect(await resumeForgetJobs()).toMatchObject({ total: 0 });
		expect(await resumeForgetJobs({ id: err.job })).toMatchObject({ results: [{ steps: 'shared', status: 'skipped' }] });
		expect(purgeUser).not.toHaveBeenCalled();
	});

	it('never runs later when the store committed the record but the reply was lost', async () => {
		const jobs = createForgetJobStore();
		const purgeUser = vi.fn(async () => 1);
		const lostReply = async (intent) => { jobs.begin(intent); throw new Error('connection reset'); };
		configureForget({ store: { purgeUser }, jobs: { ...jobs, begin: lostReply } });
		const err = await live.forget('alice', { tenantId: null }).catch((e) => e);
		expect(err.code).toBe('FORGET_JOB_FAILED');
		await vi.waitFor(async () => expect((await listForgetJobs())[0]).toMatchObject({ id: err.job, status: 'abandoned' }));
		later();
		expect(await resumeForgetJobs()).toMatchObject({ total: 0 });
		expect(purgeUser).not.toHaveBeenCalled();
	});
});

describe('reconfiguring jobs', () => {
	it('keeps the configured store when jobs: true is passed again', async () => {
		configureForget({ store: partial(), jobs: true });
		const err = await live.forget('alice', { tenantId: null }).catch((e) => e);
		configureForget({ jobs: true });
		expect((await listForgetJobs()).map((j) => j.id)).toEqual([err.job]);
	});

	it('resumes jobs on the configured interval and stops when cleared', async () => {
		setRuntimeEnv({ timers: { setInterval: (cb, _ms, ...a) => setInterval(cb, 5, ...a) } });
		const jobs = createForgetJobStore();
		configureForget({ store: partial(), jobs });
		const err = await live.forget('alice', { tenantId: null }).catch((e) => e);
		const due = vi.spyOn(jobs, 'due');
		configureForget({ store: durable(), resumeIntervalMs: 1000 });
		later();
		await vi.waitFor(async () => expect((await listForgetJobs())[0]).toMatchObject({ id: err.job, status: 'completed' }));
		configureForget(null);
		const calls = due.mock.calls.length;
		await new Promise((r) => setTimeout(r, 30));
		expect(due.mock.calls.length).toBe(calls);
	});
});

describe('in-memory steps that reach other users data', () => {
	afterEach(() => { _resetAggregates(); });

	function aggregates() {
		const platform = mockPlatform();
		const counted = live.aggregate('source', { total: { init: () => 0, reduce: (n) => n + 1 } }, { topic: 'counted', forget: 'reset' });
		const unmanaged = live.aggregate('source', { total: { init: () => 0, reduce: (n) => n + 1 } }, { topic: 'unmanaged' });
		__registerAggregate('erasure/counted', counted);
		__registerAggregate('erasure/unmanaged', unmanaged);
		_activateDerived(platform);
		return { platform, total: () => aggregateRegistry.get('erasure/counted').state.total };
	}

	it('never resets an aggregate again that a partly run step already reset', async () => {
		const { platform, total } = aggregates();
		platform.publish('source', 'added', { id: 'alice' });
		configureForget({ jobs: true });
		const err = await live.forget('alice', { tenantId: null }).catch((e) => e);
		expect(err.code).toBe('FORGET_INCOMPLETE');
		expect(total()).toBe(0);
		// Other users keep counting.
		platform.publish('source', 'added', { id: 'bob' });
		platform.publish('source', 'added', { id: 'carol' });
		later();
		await resumeForgetJobs();
		await resumeForgetJobs();
		expect(total()).toBe(2);
		// The aggregate without a policy can never succeed: reported once, kept blocked.
		expect(events.filter((e) => e.event === 'forget.local-exhausted').map((e) => e.attributes)).toEqual([{ job: err.job, attempts: 1, reason: 'blocked' }]);
		expect((await listForgetJobs())[0].local).toMatchObject({ open: [], blocked: ['aggregateCohorts'], exhausted: true });
	});

	it('never drops a document again that a partly run step already dropped', async () => {
		const drop = vi.fn(() => true);
		_crdtDecls.set('notes', { authority: { drop } });
		_crdtDecls.set('legacy', { authority: {} }); // no drop: can never succeed
		configureForget({ jobs: true });
		const err = await live.forget('alice', { tenantId: null, cascade: { crdt: ['notes:1'] } }).catch((e) => e);
		expect(err.code).toBe('FORGET_INCOMPLETE');
		later();
		await resumeForgetJobs();
		await resumeForgetJobs({ id: err.job });
		expect(drop).toHaveBeenCalledTimes(1);
	});

	it('retries only the documents whose drop failed', async () => {
		let fail = true;
		const drop = vi.fn((name) => { if (name === 'notes:a' && fail) { fail = false; throw new Error('busy'); } return true; });
		_crdtDecls.set('notes', { authority: { drop } });
		configureForget({ jobs: true });
		await live.forget('alice', { tenantId: null, cascade: { crdt: ['notes:a', 'notes:b'] } }).catch(() => {});
		later();
		expect(await resumeForgetJobs()).toMatchObject({ completed: 1, results: [{ steps: 'local', status: 'completed' }] });
		expect(drop.mock.calls.map(([name]) => name)).toEqual(['notes:a', 'notes:b', 'notes:a']);
	});
});

describe('in-memory work without a job store', () => {
	it('lists and retries owed in-memory steps after the job store is cleared or the record is gone', async () => {
		const purge = flakyMemoryDeadLetter(1);
		const jobs = createForgetJobStore({ max: 1 });
		configureForget({ jobs });
		const err = await live.forget('alice', { tenantId: null }).catch((e) => e);
		// The completed record is evicted by the next erasure; the owed work still shows.
		configureWebhooks({ deadLetter: false });
		await live.forget('bob', { tenantId: null });
		expect((await listForgetJobs()).find((j) => j.id === err.job)).toMatchObject({ status: null, local: { open: ['webhookDeadLetter'] } });
		flakyMemoryDeadLetter(0);
		configureForget(null);
		expect((await listForgetJobs()).map((j) => j.id)).toEqual([err.job]);
		later();
		expect(await resumeForgetJobs()).toMatchObject({ completed: 1, results: [{ id: err.job, steps: 'local', status: 'completed' }] });
		expect(await listForgetJobs()).toEqual([]);
		expect(purge).toHaveBeenCalledTimes(1);
	});

	it('drops exhausted in-memory work when the configuration is cleared, and keeps work still retried', async () => {
		_crdtDecls.set('legacy', { authority: {} }); // can never drop: the job is exhausted at once
		configureForget({ jobs: true });
		const blocked = await live.forget('alice', { tenantId: null, cascade: { crdt: ['notes:1'] } }).catch((e) => e);
		_crdtDecls.clear();
		flakyMemoryDeadLetter(Infinity);
		const retried = await live.forget('bob', { tenantId: null }).catch((e) => e);
		expect((await listForgetJobs()).filter((j) => j.local !== null).map((j) => j.id)).toEqual([blocked.job, retried.job]);
		configureForget(null);
		expect((await listForgetJobs()).map((j) => j.id)).toEqual([retried.job]);
	});
});
