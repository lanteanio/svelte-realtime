<script>
	import { onMount } from 'svelte';
	import { get } from 'svelte/store';
	import { status } from 'svelte-adapter-uws/client';
	import {
		lobby,
		roster,
		room,
		sendToLobby,
		joinRoster,
		sendToRoom,
		resetChannels
	} from '$live/channels';

	const r1 = room('r1');
	const r2 = room('r2');

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

	function asMultisetById(v) {
		if (!Array.isArray(v)) return null;
		return v.slice().sort((a, b) => String(a.id).localeCompare(String(b.id)));
	}

	function asMultisetByKey(v) {
		if (!Array.isArray(v)) return null;
		return v.slice().sort((a, b) => String(a.key).localeCompare(String(b.key)));
	}

	function sameAs(expected, sorter) {
		const want = JSON.stringify(sorter(expected));
		return (v) => JSON.stringify(sorter(v)) === want;
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
				await waitFor(lobby, (v) => Array.isArray(v));
				await waitFor(roster, (v) => Array.isArray(v));
				await waitFor(r1, (v) => Array.isArray(v));
				await waitFor(r2, (v) => Array.isArray(v));
			},
			reset: async () => {
				await waitForOpen();
				await resetChannels();
				await waitFor(lobby, (v) => Array.isArray(v) && v.length === 0);
				await waitFor(roster, (v) => Array.isArray(v) && v.length === 0);
				await waitFor(r1, (v) => Array.isArray(v) && v.length === 0);
				await waitFor(r2, (v) => Array.isArray(v) && v.length === 0);
				// Drain late refreshed:[] frames (uws frame batching).
				await new Promise((r) => setTimeout(r, 100));
			},
			readLobby: () => get(lobby),
			readRoster: () => get(roster),
			readRoom1: () => get(r1),
			readRoom2: () => get(r2),
			waitLobby: (expected) => waitFor(lobby, sameAs(expected, asMultisetById)),
			waitRoster: (expected) => waitFor(roster, sameAs(expected, asMultisetByKey)),
			waitRoom1: (expected) => waitFor(r1, sameAs(expected, asMultisetById)),
			waitRoom2: (expected) => waitFor(r2, sameAs(expected, asMultisetById)),
			sendLobby: async (text) => sendToLobby({ text }),
			joinRoster: async (name) => joinRoster({ name }),
			sendRoom: async (roomId, text) => sendToRoom({ roomId, text })
		};
	});
</script>

<h1>channels e2e</h1>
<ul data-testid="lobby">
	{#each $lobby as msg (msg.id)}
		<li data-id={msg.id} data-text={msg.text}>{msg.id}={msg.text}</li>
	{/each}
</ul>
<ul data-testid="roster">
	{#each $roster as user (user.key)}
		<li data-key={user.key} data-name={user.name}>{user.key}={user.name}</li>
	{/each}
</ul>
<ul data-testid="room-r1">
	{#each $r1 as msg (msg.id)}
		<li data-id={msg.id} data-text={msg.text}>{msg.id}={msg.text}</li>
	{/each}
</ul>
<ul data-testid="room-r2">
	{#each $r2 as msg (msg.id)}
		<li data-id={msg.id} data-text={msg.text}>{msg.id}={msg.text}</li>
	{/each}
</ul>
