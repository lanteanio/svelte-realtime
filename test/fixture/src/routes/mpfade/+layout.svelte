<script>
	import { page } from '$app/state';
	import { fade } from 'svelte/transition';

	let { children } = $props();
</script>

<!-- A page transition: the page being left stays, paused, until its fade
     ends, and Svelte runs its cleanups after that with no effect active. -->
{#key page.url.pathname}
	<div out:fade|global={{ duration: 300 }}>
		{@render children()}
	</div>
{/key}
