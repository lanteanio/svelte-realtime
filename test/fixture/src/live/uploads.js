// E2E upload handler. Echoes bytes received + positional args so the
// browser-side test can verify single-chunk and multi-chunk round-trips
// against both the Vite dev server and the production-built adapter.

import { live, LiveError } from 'svelte-realtime/server';

// Sentinel: a plain RPC on the same module to confirm the fixture page
// can talk to the server at all (i.e. distinguish "WS is broken" from
// "live.upload is broken").
export const ping = live(async (ctx, msg) => ({ pong: msg }));

export const echoBytes = live.upload(async (ctx, label) => {
	let bytes = 0;
	let chunks = 0;
	let firstByte = -1;
	let lastByte = -1;
	for await (const chunk of ctx.stream) {
		if (chunk.byteLength === 0) continue;
		if (firstByte < 0) firstByte = chunk[0];
		lastByte = chunk[chunk.byteLength - 1];
		bytes += chunk.byteLength;
		chunks++;
	}
	return { label, bytes, chunks, firstByte, lastByte };
});

// A handler that consumes the stream slowly so the e2e test can cancel
// mid-upload and assert the AbortSignal fires server-side.
export const slowSink = live.upload(async (ctx) => {
	let bytes = 0;
	let aborted = false;
	try {
		for await (const chunk of ctx.stream) {
			bytes += chunk.byteLength;
			// Yield between chunks so a client cancel has a chance to land.
			await new Promise((r) => setTimeout(r, 20));
		}
	} catch (err) {
		aborted = ctx.signal.aborted;
		throw err instanceof LiveError ? err : new LiveError('CANCELLED', 'consumer aborted');
	}
	return { bytes, aborted };
});
