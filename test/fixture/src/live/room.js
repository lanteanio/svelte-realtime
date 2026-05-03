// Live module backing the live.room() e2e tests.
//
//   board                  -> live.room() bundling data + presence +
//                             cursors + scoped actions for a board.
//   board.data(boardId)    -> per-board card list (`merge: 'crud'`,
//                             keyed by `.id`). Hot-path events:
//                             `created` / `deleted` / `refreshed`.
//   board.presence(boardId)-> per-board presence stream populated by
//                             the room's onSubscribe/onUnsubscribe
//                             auto-join hooks.
//   board.cursors(boardId) -> per-board cursor stream (`merge:
//                             'cursor'`, keyed by `.key`).
//   board.addCard(b, t)    -> publishes `created` on the room topic.
//   board.removeCard(b, c) -> publishes `deleted` on the room topic.
//   board.resetBoard(b)    -> clears in-memory cards for that board
//                             and publishes `refreshed: []`.
//   setCursor(b, x, y)     -> separate live() action that publishes
//                             `update` on the cursor sub-topic, since
//                             room actions scope ctx.publish() to the
//                             room's main topic only.

import { live } from 'svelte-realtime/server';

/** @type {Map<string, Array<{ id: string, title: string }>>} */
const _boards = new Map();
let _cardCounter = 0;

function _cardsFor(boardId) {
	let arr = _boards.get(boardId);
	if (!arr) { arr = []; _boards.set(boardId, arr); }
	return arr;
}

export const board = live.room({
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
		},
		resetBoard: async (ctx, boardId) => {
			_boards.set(boardId, []);
			ctx.publish('refreshed', []);
			return { ok: true };
		}
	}
});

// Cursor publishing as a top-level live() action: room actions wrap
// ctx.publish(event, data) to forward to the room's main topic, which
// would publish cursor frames into the data stream rather than the
// :cursors sub-topic. A standalone live() keeps the original 3-arg
// ctx.publish(topic, event, data) signature.
export const setCursor = live(async (ctx, boardId, x, y) => {
	const key = ctx.user.id;
	const entry = { key, x: Number(x) || 0, y: Number(y) || 0 };
	ctx.publish('board:' + boardId + ':cursors', 'update', entry);
	return entry;
});
