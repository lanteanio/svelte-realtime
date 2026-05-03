// Live module backing the channels e2e tests.
//
//   lobby            -> static channel, `merge: 'crud'` keyed on `id`.
//                       Hot-path event: `created`.
//   roster           -> static channel, `merge: 'presence'`. Items keyed
//                       on `ctx.user.id`. Hot-path event: `join`.
//   room(roomId)     -> dynamic channel, `merge: 'crud'` keyed on `id`,
//                       per-room topic `channel:<roomId>`. Hot-path
//                       event: `sent`.
//   sendToLobby(t)   -> publishes `created` to the lobby channel.
//   joinRoster(name) -> publishes `join` to the roster channel.
//   sendToRoom(r, t) -> publishes `sent` to the per-room channel.
//   resetChannels()  -> publishes `refreshed: []` to every known topic
//                       so subscribed clients drop accumulated state.
//                       Channels are ephemeral (no DB), so there is no
//                       server-side buffer to clear -- only the client
//                       view needs to be reset.

import { live } from 'svelte-realtime/server';

const LOBBY_TOPIC = 'channel:lobby';
const ROSTER_TOPIC = 'channel:roster';

/** @type {Set<string>} */
const _knownRoomTopics = new Set();

let _seq = 0;

export const lobby = live.channel(LOBBY_TOPIC, { merge: 'crud', key: 'id' });

export const roster = live.channel(ROSTER_TOPIC, { merge: 'presence' });

export const room = live.channel(
	(ctx, roomId) => 'channel:room:' + roomId,
	{ merge: 'crud', key: 'id' }
);

export const sendToLobby = live(async (ctx, body) => {
	const id = 'msg-' + (++_seq);
	const text = (body && body.text) || '';
	const entry = { id, text, by: ctx.user.id };
	ctx.publish(LOBBY_TOPIC, 'created', entry);
	return entry;
});

export const joinRoster = live(async (ctx, body) => {
	const key = ctx.user.id;
	const name = (body && body.name) || ctx.user.id;
	const entry = { key, name };
	ctx.publish(ROSTER_TOPIC, 'join', entry);
	return entry;
});

export const sendToRoom = live(async (ctx, body) => {
	const roomId = (body && body.roomId) || '';
	const text = (body && body.text) || '';
	const topic = 'channel:room:' + roomId;
	_knownRoomTopics.add(topic);
	const id = 'msg-' + (++_seq);
	const entry = { id, text, by: ctx.user.id, roomId };
	// crud merge expects 'created' / 'updated' / 'deleted' / 'refreshed' / 'set'.
	ctx.publish(topic, 'created', entry);
	return entry;
});

export const resetChannels = live(async (ctx) => {
	_seq = 0;
	ctx.publish(LOBBY_TOPIC, 'refreshed', []);
	ctx.publish(ROSTER_TOPIC, 'refreshed', []);
	for (const topic of _knownRoomTopics) {
		ctx.publish(topic, 'refreshed', []);
	}
	return { ok: true };
});
