import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { live, configureForget, configureWebhooks, _resetForget, __registerAggregate, _activateDerived, _resetAggregates } from '../src/server.js';
import { _pushRegistry } from '../src/server/push.js';
import { aggregateRegistry } from '../src/server/state.js';
import { mockPlatform } from './helpers/mock-platform.js';
import { _crdtDecls } from '../src/server/crdt.js';
import { setOperationalEventSink } from '../src/shared/diagnostic.js';

const store = (purgeUser) => ({ add: () => '1', get: () => null, remove: () => false,
	count: () => 1, list: () => [], summary: () => ({}), clear: () => {}, ...(purgeUser ? { purgeUser } : {}) });
let events;
let restoreSink;
beforeEach(() => {
	_resetForget();
	_resetAggregates();
	configureWebhooks({ deadLetter: false });
	events = [];
	restoreSink = setOperationalEventSink(record => events.push(record));
});
afterEach(() => {
	_resetForget();
	_resetAggregates();
	configureWebhooks({ deadLetter: false });
	_pushRegistry.clear();
	_crdtDecls.clear();
	restoreSink();
});

describe('incomplete erasure', () => {
	it.each([false, true])('rejects a failed surface while attempting later memory and durable surfaces (async: %s)', async (asyncFailure) => {
		const failure = new Error('private.person@example.test remains');
		const purgeUser = asyncFailure ? () => Promise.reject(failure) : () => { throw failure; };
		configureWebhooks({ deadLetter: store(purgeUser) });
		const aggregate = live.aggregate('source', { total: { init: () => 0, reduce: value => value + 1 } }, {
			topic: 'output', forget: 'reset', privacy: { k: 2, strategy: 'suppress', contributor: value => value.id }
		});
		__registerAggregate('failure/aggregate', aggregate);
		const platform = mockPlatform();
		_activateDerived(platform);
		platform.publish('source', 'added', { id: 'member' });
		const cohort = aggregateRegistry.get('failure/aggregate').cohort;
		expect(cohort.has('member')).toBe(true);
		const durable = vi.fn(async () => 3);
		configureForget({ store: { purgeUser: durable } });
		const onForget = vi.fn();
		await expect(live.forget('member', { onForget })).rejects.toMatchObject({ code: 'FORGET_INCOMPLETE' });
		expect(cohort.has('member')).toBe(false);
		expect(durable).toHaveBeenCalledWith(null, 'member', true);
		expect(onForget).not.toHaveBeenCalled();
		expect(events).toContainEqual(expect.objectContaining({
			event: 'forget.incomplete', severity: 'error',
			attributes: expect.objectContaining({ failedSurfaces: ['webhookDeadLetter'] })
		}));
		expect(JSON.stringify(events)).not.toContain('private.person');
	});

	it('rejects an enabled surface without an erasure method', async () => {
		configureWebhooks({ deadLetter: store() });
		await expect(live.forget('member')).rejects.toMatchObject({ code: 'FORGET_INCOMPLETE' });
	});

	it('permits a successful retry after the failed surface recovers', async () => {
		const purgeUser = vi.fn().mockRejectedValueOnce(new Error('temporarily down')).mockResolvedValueOnce(1);
		configureWebhooks({ deadLetter: store(purgeUser) });
		await expect(live.forget('member')).rejects.toMatchObject({ code: 'FORGET_INCOMPLETE' });
		await expect(live.forget('member')).resolves.toMatchObject({ ok: true, surfaces: { webhookDeadLetter: 1 } });
	});
	it.each([{}, { drop() { throw new Error('private document failure'); } }])('rejects an unavailable CRDT erasure while still invoking the durable store', async (authority) => {
		_crdtDecls.set('broken', { authority });
		const durable = vi.fn(async () => 1);
		configureForget({ store: { purgeUser: durable } });
		await expect(live.forget('member', { cascade: { crdt: ['notes'] } })).rejects.toMatchObject({ code: 'FORGET_INCOMPLETE' });
		expect(durable).toHaveBeenCalledOnce();
	});

	it('attempts remaining document names and authorities after an individual drop fails', async () => {
		const first = vi.fn(name => { if (name === 'broken') throw new Error('unavailable'); return true; });
		const second = vi.fn(() => true);
		_crdtDecls.set('first', { authority: { drop: first } });
		_crdtDecls.set('second', { authority: { drop: second } });
		await expect(live.forget('member', { cascade: { crdt: ['broken', 'healthy'] } })).rejects.toMatchObject({ code: 'FORGET_INCOMPLETE' });
		expect(first.mock.calls).toEqual([['broken'], ['healthy']]);
		expect(second.mock.calls).toEqual([['broken'], ['healthy']]);
	});

	it.each([undefined, false, NaN, Infinity, -1, { ok: false }])('rejects a malformed purge count (%s)', async value => {
		configureWebhooks({ deadLetter: store(() => value) });
		await expect(live.forget('member')).rejects.toMatchObject({ code: 'FORGET_INCOMPLETE' });
	});

});
