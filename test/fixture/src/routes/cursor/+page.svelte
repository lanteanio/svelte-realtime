<script>
	import { onMount } from 'svelte';
	import { get } from 'svelte/store';
	import { status } from 'svelte-adapter-uws/client';
	import { cursors, moveCursor, removeCursor, resetCursor } from '$live/cursor';

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
				const v = get(cursors);
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
				await resetCursor();
				await waitFor((v) => Array.isArray(v) && v.length === 0);
				await new Promise((r) => setTimeout(r, 100));
			},
			read: () => get(cursors),
			waitCursors: (expected) => waitFor(sameAs(expected)),
			move: async ({ x, y, color }) => moveCursor({ x, y, color }),
			remove: async () => removeCursor()
		};
	});
</script>

<h1>cursor e2e</h1>
<ul data-testid="cursors">
	{#each $cursors as c (c.key)}
		<li data-key={c.key} data-x={c.x} data-y={c.y} data-color={c.color}>
			{c.key}={c.x},{c.y},{c.color}
		</li>
	{/each}
</ul>
