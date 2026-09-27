<script>
	import { getContext } from 'svelte';
	import { goto } from '$app/navigation';

	const room = getContext('mp-room');
	let locking = $state(false);

	$effect(() => {
		// @ts-ignore -- test-only API
		window.__mp = { goto: (url) => goto(url), lock: (on) => { locking = on; } };
	});

	// Taken through the layout's room; released by the cleanup, which runs
	// after the fade, when that room is already on the next board.
	$effect(() => {
		if (!locking) return;
		const here = room.here();
		here.acquireLock('title');
		return () => here.releaseLock('title');
	});
</script>
