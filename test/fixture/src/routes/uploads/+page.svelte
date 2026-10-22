<script>
	import { onMount } from 'svelte';
	import { echoBytes, slowSink, ping } from '$live/uploads';
	import { configure } from 'svelte-realtime/client';

	let lastResult = $state('');

	function makeBuffer(size, fillStart = 1) {
		const u8 = new Uint8Array(size);
		for (let i = 0; i < size; i++) u8[i] = (fillStart + i) & 0xff;
		return u8.buffer;
	}
	function frameSizeFor(rpc, args, payloadBytes) {
		const envelope = args.length ? { rpc, args } : { rpc };
		return 12 + new TextEncoder().encode(JSON.stringify(envelope)).length + payloadBytes;
	}

	onMount(() => {
		// @ts-ignore -- test-only API
		window.__test = {
			ping: async (msg) => ping(msg),
			setChunkSize: (chunkSize) => {
				configure({ upload: { chunkSize } });
			},
			singleChunk: async (size = 64) => {
				const r = await echoBytes(makeBuffer(size, 1), 'single');
				lastResult = JSON.stringify(r);
				return r;
			},
			multiChunk: async (size, payloadBytes) => {
				const frameSize = frameSizeFor('uploads/echoBytes', ['multi'], payloadBytes);
				configure({ upload: { frameSize } });
				const r = await echoBytes(makeBuffer(size, 1), 'multi');
				lastResult = JSON.stringify(r);
				return { ...r, frameSize };
			},
			cancelMidUpload: async () => {
				configure({ upload: { frameSize: frameSizeFor('uploads/slowSink', [], 1) } });
				const handle = slowSink(makeBuffer(40, 1));
				// Wait long enough for at least one chunk to land server-side
				await new Promise((r) => setTimeout(r, 50));
				handle.cancel('user clicked stop');
				try {
					await handle;
					return { ok: true, code: null };
				} catch (err) {
					return { ok: false, code: err.code, message: err.message };
				}
			},
			peekProgress: async (size, payloadBytes) => {
				const frameSize = frameSizeFor('uploads/echoBytes', ['peek'], payloadBytes);
				configure({ upload: { frameSize } });
				const events = [];
				const handle = echoBytes(makeBuffer(size, 1), 'peek');
				handle.on('progress', (p) => events.push({ sent: p.sent, chunks: p.chunks }));
				const r = await handle;
				return { result: r, events, frameSize };
			}
		};
	});
</script>

<h1>uploads e2e</h1>
<pre data-testid="last-result">{lastResult}</pre>
