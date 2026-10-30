<script>
	import { onMount } from 'svelte';
	import { get } from 'svelte/store';
	import { hydratedStats, bumpHydrated } from '$live/derived';

	let { data } = $props();

	const stats = hydratedStats.hydrate(data.stats);

	function waitForStore(store, predicate, timeoutMs = 5000) {
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
			ssrValue: () => data.stats.value,
			read: () => get(stats),
			// Resolves once the subscribe response has been applied, so the
			// socket is on the output topic and later recomputes reach it.
			subscribed: () => waitForStore(stats.status, (s) => s === 'connected'),
			wait: (predicateSrc, timeoutMs) => waitForStore(stats, new Function('v', 'return ' + predicateSrc), timeoutMs),
			bump: () => bumpHydrated()
		};
	});
</script>

<h1>hydrated derived e2e</h1>
<pre data-testid="hydrated">{JSON.stringify($stats)}</pre>
