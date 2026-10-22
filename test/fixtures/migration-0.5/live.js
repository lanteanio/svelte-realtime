// A server module written against svelte-realtime 0.5.14, with the
// registration lines the 0.5 Vite plugin generates for it. It loads and
// serves unedited on 0.5.14; the migration rehearsal applies the documented
// 0.6 edits to a copy.
import { live, realtime, __register, __registerRoomActions } from 'svelte-realtime/server';

export const handler = realtime();

// A room action named after a generated client member.
export const board = live.room({
	topic: (ctx, boardId) => 'board:' + boardId,
	topicArgs: 1,
	init: async () => [],
	actions: {
		presence: async (ctx, boardId, status) => ({ boardId, status, by: ctx.user.id })
	}
});
__register('board/board/__data', board.__dataStream);
__registerRoomActions('board/board', async () => board);

export const whoami = live((ctx) => ({ id: ctx.user.id }));
__register('account/whoami', whoami);
