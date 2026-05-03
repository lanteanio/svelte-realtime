<script>
	import { onMount } from 'svelte';
	import { get } from 'svelte/store';
	import { status } from 'svelte-adapter-uws/client';
	import { presence, joinPresence, leavePresence, resetPresence } from '$live/presence';

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

	function asMultiset(v) {
		if (!Array.isArray(v)) return null;
		return v.slice().sort((a, b) => String(a.key).localeCompare(String(b.key)));
	}

	function sameAs(expected) {
		const want = JSON.stringify(asMultiset(expected));
		return (v) => JSON.stringify(asMultiset(v)) === want;
	}

	function waitFor(predicate, timeoutMs = 5000) {
		return new Promise((resolve, reject) => {
			const start = Date.now();
			const check = () => {
				const v = get(presence);
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
				await waitFor((v) => Array.isArray(v));
			},
			reset: async () => {
				await waitForOpen();
				await resetPresence();
				await waitFor((v) => Array.isArray(v) && v.length === 0);
				// Drain late refreshed:[] frames (uws frame batching).
				await new Promise((r) => setTimeout(r, 100));
			},
			read: () => get(presence),
			waitRoster: (expected) => waitFor(sameAs(expected)),
			join: async (name) => joinPresence({ name }),
			leave: async () => leavePresence()
		};
	});
</script>

<h1>presence e2e</h1>
<ul data-testid="roster">
	{#each $presence as user (user.key)}
		<li data-key={user.key} data-name={user.name}>{user.key}={user.name}</li>
	{/each}
</ul>
