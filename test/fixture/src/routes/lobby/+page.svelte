<script>
	import { onMount } from 'svelte';
	import { get } from 'svelte/store';
	import { status } from 'svelte-adapter-uws/client';
	import { lobby } from '$live/lobby';

	// Lobby browser: subscribed for the page's lifetime so the spec can watch
	// the enumeration registry (rooms + cluster-wide member counts) live.
	const browserView = lobby.rooms();

	let roster = $state([]);
	let owner = $state(null);
	let offs = [];

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

	function join(id) {
		const dataStream = lobby.data(id);
		const presStream = lobby.presence(id);
		const ownerStream = lobby.owner(id);
		offs = [
			dataStream.subscribe(() => {}),
			presStream.subscribe((v) => { roster = v ?? []; }),
			ownerStream.subscribe((v) => { owner = v ?? null; })
		];
	}

	// Leave with the SOCKET STILL OPEN: dropping the last local subscriber of
	// each sub-stream releases the WS subscriptions, so the server sees three
	// topic unsubscribes on a live connection - the path that must decrement
	// the cluster registry and run the presence leave / owner succession.
	function leave() {
		for (const off of offs) off();
		offs = [];
		roster = [];
		owner = null;
	}

	function readRooms() {
		return [...browserView.rooms].map(([key, r]) => ({ key, count: r.count }));
	}

	function waitFor(read, predicate, timeoutMs = 15000) {
		return new Promise((resolve, reject) => {
			const start = Date.now();
			const check = () => {
				const v = read();
				if (predicate(v)) return resolve(v);
				if (Date.now() - start > timeoutMs) {
					return reject(new Error('waitFor timeout: ' + JSON.stringify(v)));
				}
				setTimeout(check, 50);
			};
			check();
		});
	}

	onMount(() => {
		// @ts-ignore -- test-only API
		window.__test = {
			ready: () => waitForOpen(),
			join,
			leave,
			readRoster: () => roster.map((e) => e.key).sort(),
			readOwner: () => owner,
			readRooms,
			waitRoster: (expected, timeoutMs) =>
				waitFor(
					() => roster.map((e) => e.key).sort(),
					(v) => JSON.stringify(v) === JSON.stringify(expected.slice().sort()),
					timeoutMs
				),
			waitRoomCount: (key, count, timeoutMs) =>
				waitFor(
					readRooms,
					(v) => {
						const entry = v.find((r) => r.key === key);
						return count === null ? entry === undefined : !!entry && entry.count === count;
					},
					timeoutMs
				)
		};
	});
</script>

<h1>lobby cluster e2e</h1>

<section>
	<h2>roster</h2>
	<ul data-testid="lobby-roster">
		{#each roster as user (user.key)}
			<li data-key={user.key}>{user.key}</li>
		{/each}
	</ul>
</section>

<section>
	<h2>owner</h2>
	<span data-testid="lobby-owner">{owner?.key ?? '-'}</span>
</section>

<section>
	<h2>rooms</h2>
	<ul data-testid="lobby-rooms">
		{#each [...browserView.rooms] as [key, r] (key)}
			<li data-key={key} data-count={r.count}>{key}={r.count}</li>
		{/each}
	</ul>
</section>
