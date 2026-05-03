// Live module backing the cron e2e tests.
//
//   stats     -> set-merged stream. A cron job ('* * * * *') fires
//                and returns { tickCount, ts }; the framework
//                auto-publishes a `set` event with the return value.
//   feed      -> crud-merged stream keyed on `id`. A second cron job
//                ('* * * * *') uses ctx.publish('feed', 'created', ...)
//                and returns undefined to skip auto-publish.
//   tickNow   -> RPC that calls _tickCron() so tests can fire the cron
//                deterministically without waiting for the next minute.
//   getCounts -> RPC returning { ticks, itemCount } for assertions.
//   resetCron -> Zeroes counters and republishes a clean baseline so a
//                fresh test starts with a known state.

import { live, _tickCron } from 'svelte-realtime/server';

let _ticks = 0;
let _itemCount = 0;
/** @type {{ tickCount: number, ts: number } | null} */
let _lastStats = null;
/** @type {Array<{ id: string, label: string }>} */
let _feedItems = [];

export const stats = live.stream(
	'stats',
	async () => _lastStats,
	{ merge: 'set' }
);

export const feed = live.stream(
	'feed',
	async () => _feedItems.slice(),
	{ merge: 'crud', key: 'id' }
);

export const statsCron = live.cron('* * * * *', 'stats', async () => {
	_ticks += 1;
	_lastStats = { tickCount: _ticks, ts: Date.now() };
	return _lastStats;
});

export const feedCron = live.cron('* * * * *', 'feed', async (ctx) => {
	_itemCount += 1;
	const item = { id: 'i' + _itemCount, label: 'cron-' + _itemCount };
	_feedItems.push(item);
	ctx.publish('feed', 'created', item);
	// return undefined -> framework skips the auto `set` publish, so the
	// crud stream keeps its `created` event semantics.
});

export const tickNow = live(async () => {
	await _tickCron();
	// Give the platform.publish frame a tick to flush before the RPC
	// response returns. uws frame-batching can otherwise deliver the
	// response before the broadcast.
	await new Promise((r) => setTimeout(r, 20));
	return { ok: true };
});

export const getCounts = live(async () => {
	return { ticks: _ticks, itemCount: _itemCount };
});

export const resetCron = live(async (ctx) => {
	_ticks = 0;
	_itemCount = 0;
	_lastStats = null;
	_feedItems = [];
	ctx.publish('feed', 'refreshed', []);
	ctx.publish('stats', 'set', null);
	return { ok: true };
});
