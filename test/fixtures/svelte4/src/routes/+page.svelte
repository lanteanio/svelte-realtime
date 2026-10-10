<script>
	import { counter, increment } from '$live/counter';
	const status = counter.status;
	const error = counter.error;
	let failure = '';
	async function increase() {
		try { await increment(); }
		catch (error) { failure = error instanceof Error ? error.message : 'Failed'; }
	}
</script>

<h1>Svelte 4 realtime fixture</h1>
<p id="count">{$counter === undefined ? 'Connecting' : 'Count: ' + $counter}</p>
<p id="error">{failure || $error?.message || ''}</p>
<button on:click={increase} disabled={$status !== 'connected'}>Increment</button>
