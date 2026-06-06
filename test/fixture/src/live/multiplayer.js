// Live module demonstrating live.multiplayer() for the fixture app build.
//
//   room                   -> live.multiplayer() bundling data + presence +
//                             cursors for a board. Composes the same
//                             sub-stream machinery live.room() uses, so the
//                             generated client export resolves room.data /
//                             room.presence / room.cursors / room.status and
//                             the room.move / room.reportViewport cursor
//                             methods.
//   room.data(boardId)     -> per-board card list (`merge: 'crud'`, keyed
//                             by `.id`). Hot-path events: `created` /
//                             `deleted` / `refreshed`.
//   room.presence(boardId) -> per-board presence stream populated by the
//                             onSubscribe / onUnsubscribe auto-join hooks.
//   room.cursors(boardId)  -> per-board cursor stream (`merge: 'cursor'`,
//                             keyed by `.key`). The generated room.move /
//                             room.reportViewport methods publish a keyed
//                             update onto this sub-topic via the built-in
//                             cursor handlers, so a move shows up here.
//   room.addCard(b, t)     -> publishes `created` on the main topic.
//   moveCursor(b, x, y)    -> a separate standalone live() action kept here
//                             to show the raw 3-arg ctx.publish(topic, event,
//                             data) cursor primitive. It is NOT what the
//                             generated room.move / room.reportViewport drive
//                             (those bind to the built-in cursor handlers);
//                             it stands alone as a publish-primitive example.

import { live } from 'svelte-realtime/server';

/** @type {Map<string, Array<{ id: string, title: string }>>} */
const _boards = new Map();
let _cardCounter = 0;

function _cardsFor(boardId) {
	let arr = _boards.get(boardId);
	if (!arr) { arr = []; _boards.set(boardId, arr); }
	return arr;
}

export const room = live.multiplayer({
	topic: (ctx, boardId) => 'board:' + boardId,
	topicArgs: 1,
	init: async (ctx, boardId) => _cardsFor(boardId).slice(),
	presence: (ctx) => ({ name: ctx.user.id }),
	cursors: true,
	actions: {
		addCard: async (ctx, boardId, title) => {
			const id = 'c' + (++_cardCounter);
			const card = { id, title: String(title) };
			_cardsFor(boardId).push(card);
			ctx.publish('created', card);
			return card;
		},
		removeCard: async (ctx, boardId, cardId) => {
			const arr = _cardsFor(boardId);
			const idx = arr.findIndex((c) => c.id === cardId);
			if (idx >= 0) arr.splice(idx, 1);
			ctx.publish('deleted', { id: cardId });
			return { id: cardId };
		}
	}
});

// Cursor publishing as a top-level live() action: bundled actions wrap
// ctx.publish(event, data) to forward to the room's main topic, which
// would publish cursor frames into the data stream rather than the
// :cursors sub-topic. A standalone live() keeps the original 3-arg
// ctx.publish(topic, event, data) signature the cursor merge expects.
export const moveCursor = live(async (ctx, boardId, x, y) => {
	const key = ctx.user.id;
	const entry = { key, x: Number(x) || 0, y: Number(y) || 0 };
	ctx.publish('board:' + boardId + ':cursors', 'update', entry);
	return entry;
});
