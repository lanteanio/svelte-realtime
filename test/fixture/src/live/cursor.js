// Live module backing the cursor merge-strategy e2e tests.
//
//   cursors          -> per-doc stream with `merge: 'cursor'`. Items
//                       keyed by `.key`. Hot-path events: `update` /
//                       `remove`.
//   moveCursor(x,y)  -> publishes `update` with the caller's identity.
//   removeCursor()   -> publishes `remove` for the caller's pid.
//   resetCursor()    -> clears the in-memory map + publishes
//                       `refreshed: []`.

import { live } from 'svelte-realtime/server';

const DOC = 'doc-1';
const TOPIC = 'cursors:' + DOC;

/** @type {Map<string, { key: string, x: number, y: number, color: string }>} */
const _positions = new Map();

export const cursors = live.stream(
	TOPIC,
	async () => Array.from(_positions.values()),
	{ merge: 'cursor' }
);

export const moveCursor = live(async (ctx, body) => {
	const key = ctx.user.id;
	const entry = {
		key,
		x: Number(body.x) || 0,
		y: Number(body.y) || 0,
		color: (body && body.color) || '#000000'
	};
	_positions.set(key, entry);
	ctx.publish(TOPIC, 'update', entry);
	return entry;
});

export const removeCursor = live(async (ctx) => {
	const key = ctx.user.id;
	_positions.delete(key);
	ctx.publish(TOPIC, 'remove', { key });
	return { key };
});

export const resetCursor = live(async (ctx) => {
	_positions.clear();
	ctx.publish(TOPIC, 'refreshed', []);
	return { ok: true };
});
