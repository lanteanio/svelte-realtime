<script>
	import { onMount } from 'svelte';
	import { get } from 'svelte/store';
	import { status } from 'svelte-adapter-uws/client';
	import { board, setCursor } from '$live/room';

	const cards1 = board.data('r1');
	const cards2 = board.data('r2');
	const presence1 = board.presence('r1');
	const cursors1 = board.cursors('r1');

	function waitForOpen() {
		return new Promise((resolve) => {
			let unsub;
			unsub = status.subscribe((s) => {
				if (s === 'open') {
					if (unsub) unsub();
					resolve();
				}
			});
		});
	}

	function asMultisetByKey(v, keyField) {
		if (!Array.isArray(v)) return null;
		return v.slice().sort((a, b) => String(a[keyField]).localeCompare(String(b[keyField])));
	}

	function sameAs(expected, keyField) {
		const want = JSON.stringify(asMultisetByKey(expected, keyField));
		return (v) => JSON.stringify(asMultisetByKey(v, keyField)) === want;
	}

	function waitFor(store, predicate, timeoutMs = 5000) {
		return new Promise((resolve, reject) => {
			const start = Date.now();
			const check = () => {
				const v = get(store);
				if (predicate(v)) return resolve(v);
				if (Date.now() - start > timeoutMs) {
					return reject(new Error('waitFor timeout: ' + JSON.stringify(v)));
				}
				setTimeout(check, 20);
			};
			check();
		});
	}

	onMount(() => {
		// @ts-ignore -- test-only API
		window.__test = {
			ready: async () => {
				await waitForOpen();
				await waitFor(cards1, (v) => Array.isArray(v));
				await waitFor(cards2, (v) => Array.isArray(v));
				await waitFor(presence1, (v) => Array.isArray(v));
				await waitFor(cursors1, (v) => Array.isArray(v));
			},
			reset: async () => {
				await waitForOpen();
				await board.resetBoard('r1');
				await board.resetBoard('r2');
				await waitFor(cards1, (v) => Array.isArray(v) && v.length === 0);
				await waitFor(cards2, (v) => Array.isArray(v) && v.length === 0);
				await new Promise((r) => setTimeout(r, 100));
			},
			readCards1: () => get(cards1),
			readCards2: () => get(cards2),
			readPresence1: () => get(presence1),
			readCursors1: () => get(cursors1),
			waitCards1: (expected) => waitFor(cards1, sameAs(expected, 'id')),
			waitCards2: (expected) => waitFor(cards2, sameAs(expected, 'id')),
			waitPresence1: (expected) => waitFor(presence1, sameAs(expected, 'key')),
			waitCursors1: (expected) => waitFor(cursors1, sameAs(expected, 'key')),
			addCard1: async (title) => board.addCard('r1', title),
			addCard2: async (title) => board.addCard('r2', title),
			removeCard1: async (id) => board.removeCard('r1', id),
			setCursor1: async (x, y) => setCursor('r1', x, y)
		};
	});
</script>

<h1>room e2e</h1>

<!-- Presence + cursors are rendered (subscribed) BEFORE the data
     streams so the presence/cursor topic subscriptions are
     established on the broker BEFORE the room's data-stream
     onSubscribe fires its `join` publish. Without this ordering,
     each client's own join would be published before its own
     presence subscription existed and would never reach its own
     stream. -->

<section>
	<h2>presence r1</h2>
	<ul data-testid="presence-r1">
		{#each $presence1 as user (user.key)}
			<li data-key={user.key}>{user.key}</li>
		{/each}
	</ul>
</section>

<section>
	<h2>cursors r1</h2>
	<ul data-testid="cursors-r1">
		{#each $cursors1 as c (c.key)}
			<li data-key={c.key} data-x={c.x} data-y={c.y}>{c.key}={c.x},{c.y}</li>
		{/each}
	</ul>
</section>

<section>
	<h2>cards r1</h2>
	<ul data-testid="cards-r1">
		{#each $cards1 as card (card.id)}
			<li data-id={card.id} data-title={card.title}>{card.id}={card.title}</li>
		{/each}
	</ul>
</section>

<section>
	<h2>cards r2</h2>
	<ul data-testid="cards-r2">
		{#each $cards2 as card (card.id)}
			<li data-id={card.id} data-title={card.title}>{card.id}={card.title}</li>
		{/each}
	</ul>
</section>
