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
			multiChunk: async (size, chunkSize) => {
				configure({ upload: { chunkSize } });
				const r = await echoBytes(makeBuffer(size, 1), 'multi');
				lastResult = JSON.stringify(r);
				return r;
			},
			cancelMidUpload: async () => {
				configure({ upload: { chunkSize: 4 } });
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
			peekProgress: async (size, chunkSize) => {
				configure({ upload: { chunkSize } });
				const events = [];
				const handle = echoBytes(makeBuffer(size, 1), 'peek');
				handle.on('progress', (p) => events.push({ sent: p.sent, chunks: p.chunks }));
				const r = await handle;
				return { result: r, events };
			}
		};
	});
</script>

<h1>uploads e2e</h1>
<pre data-testid="last-result">{lastResult}</pre>
