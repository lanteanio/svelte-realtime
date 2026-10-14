<script>
	import { onMount } from 'svelte';
	import { counter, echo, increment } from '$live/counter';
	onMount(() => {
		window.compat = { echo, increment };
		return () => { delete window.compat; };
	});
</script>
<h1>Realtime compatibility</h1>
<p data-testid="counter">{$counter === undefined ? 'connecting' : $counter}</p>
