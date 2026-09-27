<script>
	import { setContext } from 'svelte';
	import { page } from '$app/state';
	import { fade } from 'svelte/transition';
	import { room as board } from '$live/multiplayer';

	let { children } = $props();

	// The layout holds the room across pages and follows the board param.
	board.identify(() => page.url.searchParams.get('me'));
	const room = board.room(() => page.params.board);
	setContext('mp-room', room);
	const members = $derived(room.others.filter((o) => o.data != null).map((o) => o.key).sort().join(','));
</script>

<p data-testid="members">{members}</p>

<!-- The page being left stays, paused, until its fade ends, while the
     layout's room has already moved to the next board. -->
{#key page.url.pathname}
	<div out:fade|global={{ duration: 300 }}>
		{@render children()}
	</div>
{/key}
