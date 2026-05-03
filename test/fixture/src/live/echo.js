// Smoke RPC: round-trips a value to confirm the basic RPC plumbing
// (Vite plugin codegen + client stub + handleRpc wiring) is alive.

import { live } from 'svelte-realtime/server';

export const echo = live(async (ctx, body) => {
	return { received: body, at: Date.now() };
});
