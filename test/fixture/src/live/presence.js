// Live module backing the presence e2e tests.
//
//   presence            -> per-room stream with `merge: 'presence'`. Items
//                          keyed by `.key`. Hot-path events: `join` /
//                          `leave`.
//   joinPresence(name)  -> publishes `join` with the caller's identity.
//                          Identity comes from a `pid` cookie so each
//                          BrowserContext has a distinct presence key.
//   leavePresence()     -> publishes `leave` for the caller's pid.
//   resetPresence()     -> clears the in-memory roster + publishes
//                          `refreshed: []` so subscribed clients drop
//                          accumulated state.

import { live } from 'svelte-realtime/server';

const ROOM = 'lobby';
const TOPIC = 'presence:' + ROOM;

/** @type {Map<string, { key: string, name: string }>} */
const _roster = new Map();

export const presence = live.stream(
	TOPIC,
	async () => Array.from(_roster.values()),
	{ merge: 'presence' }
);

export const joinPresence = live(async (ctx, body) => {
	const key = ctx.user.id;
	const name = (body && body.name) || ctx.user.id;
	const entry = { key, name };
	_roster.set(key, entry);
	ctx.publish(TOPIC, 'join', entry);
	return entry;
});

export const leavePresence = live(async (ctx) => {
	const key = ctx.user.id;
	_roster.delete(key);
	ctx.publish(TOPIC, 'leave', { key });
	return { key };
});

export const resetPresence = live(async (ctx) => {
	_roster.clear();
	ctx.publish(TOPIC, 'refreshed', []);
	return { ok: true };
});
