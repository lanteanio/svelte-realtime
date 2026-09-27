<script>
	import { onDestroy } from 'svelte';
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import { room as board } from '$live/multiplayer';

	board.identify(() => page.url.searchParams.get('me'));
	const view = board.room(() => page.params.board);
	const first = page.params.board;
	let locking = $state(false);
	const members = $derived(view.others.filter((o) => o.data != null).map((o) => o.key).sort().join(','));

	$effect(() => {
		// @ts-ignore -- test-only API
		window.__mp = { goto: (url) => goto(url), lock: (on) => { locking = on; } };
	});

	// Released by the cleanup, which runs after the fade. The page's own room
	// is paused with the page, so it is still on the board being left.
	$effect(() => {
		if (!locking) return;
		const here = view.here();
		here.acquireLock('title');
		return () => here.releaseLock('title');
	});

	// A room built in a cleanup only to send, as older code does.
	onDestroy(() => board.room(first).setTyping(false));
</script>

<p data-testid="members">{members}</p>
