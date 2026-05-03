// Lock e2e RPCs. The "ordered" RPC writes a server-side log keyed by
// arrival; the test asserts the log shows strict serialization. The
// "bounded" RPC uses maxWaitMs to trigger LOCK_TIMEOUT under contention.

import { live } from 'svelte-realtime/server';

/** @type {Array<{ name: string, t: number }>} */
let _log = [];

export const ordered = live.lock('lock-shared', async (ctx, body) => {
	_log.push({ name: body.name, t: Date.now() });
	await new Promise((r) => setTimeout(r, body.holdMs ?? 60));
	return { name: body.name };
});

export const bounded = live.lock(
	{ key: 'lock-shared', maxWaitMs: 30 },
	async (ctx, body) => {
		await new Promise((r) => setTimeout(r, body.holdMs ?? 60));
		return { name: body.name };
	}
);

export const readLog = live(async () => ({ log: _log }));

export const resetLog = live(async () => {
	_log = [];
	return { ok: true };
});
