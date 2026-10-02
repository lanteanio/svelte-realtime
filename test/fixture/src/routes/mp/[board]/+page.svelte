<script>
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import { room as board } from '$live/multiplayer';

	// The spec passes the same key the `user` cookie gives the WS upgrade, so
	// the view can exclude self.
	board.identify(() => page.url.searchParams.get('me'));
	const watching = page.url.searchParams.get('mode') === 'watch';
	// ?lock=on takes the lock as the page mounts, before its join is answered.
	let locking = $state(page.url.searchParams.get('lock') === 'on');

	// One view for the page, following the board in the URL: navigating to
	// another board leaves this one and joins the next.
	const view = watching ? board.watch(() => page.params.board) : board.room(() => page.params.board);
	const others = $derived(view.others.map((o) => o.key).sort().join(','));
	// Entries with a presence payload: users whose join has arrived.
	const members = $derived(view.others.filter((o) => o.data != null).map((o) => o.key).sort().join(','));
	const locks = $derived(Object.entries(view.locks).map(([k, holder]) => k + '=' + holder).sort().join(','));

	$effect(() => {
		// @ts-ignore -- test-only API
		window.__mp = { goto: (url) => goto(url), lock: (on) => { locking = on; } };
	});

	// An effect that only sends: on a board switch its cleanup releases the
	// lock on the board being left, and its body takes it on the next one.
	$effect(() => {
		if (!locking) return;
		// @ts-ignore -- only a room(...) view sends
		const here = view.here();
		here.acquireLock('title');
		return () => here.releaseLock('title');
	});

	// A cleanup that reads the view, after the view has moved on: it must not
	// keep the board being left joined.
	$effect(() => {
		page.params.board;
		return () => { view.others; };
	});
</script>

<p data-testid="others">{others}</p>
<p data-testid="members">{members}</p>
<p data-testid="locks">{locks}</p>
