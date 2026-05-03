// Live module backing the per-user auth e2e tests.
//
//   whoami()              -> { id, role } from ctx.user
//   inbox                 -> per-user stream keyed by ctx.user.id
//   sendToInbox({ to, text })
//                         -> writes to recipient's inbox + publishes
//                            'created' to inbox:<recipient>
//   adminAction()         -> live(...).requireRole('admin') style guard
//                            (manual check, returns LiveError on miss)
//   resetAuth()           -> clears all inboxes + publishes refreshed:[]
//                            to every active inbox topic so subscribed
//                            clients drop accumulated state

import { live, LiveError } from 'svelte-realtime/server';

/** @type {Map<string, Array<{ id: string, from: string, text: string }>>} */
const _inboxes = new Map();

/** Track active inbox topics so reset can publish refreshed:[] to each. */
const _knownInboxUsers = new Set();

export const whoami = live(async (ctx) => ({ id: ctx.user.id, role: ctx.user.role }));

export const inbox = live.stream(
	(ctx) => 'inbox:' + ctx.user.id,
	(ctx) => {
		_knownInboxUsers.add(ctx.user.id);
		return _inboxes.get(ctx.user.id) || [];
	},
	{ merge: 'crud', key: 'id' }
);

export const sendToInbox = live(async (ctx, body) => {
	const to = body.to;
	const msg = {
		id: 'm-' + Math.random().toString(36).slice(2, 10),
		from: ctx.user.id,
		text: body.text
	};
	const list = _inboxes.get(to) || [];
	list.push(msg);
	_inboxes.set(to, list);
	_knownInboxUsers.add(to);
	ctx.publish('inbox:' + to, 'created', msg);
	return msg;
});

export const adminAction = live(async (ctx) => {
	if (ctx.user.role !== 'admin') {
		throw new LiveError('FORBIDDEN', 'admin only');
	}
	return { ok: true, by: ctx.user.id };
});

export const resetAuth = live(async (ctx) => {
	_inboxes.clear();
	for (const u of _knownInboxUsers) {
		ctx.publish('inbox:' + u, 'refreshed', []);
	}
	_knownInboxUsers.clear();
	return { ok: true };
});
