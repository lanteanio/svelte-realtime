<script>
	import { onMount } from 'svelte';
	import { get } from 'svelte/store';
	import { status } from 'svelte-adapter-uws/client';
	import { stats, feed, tickNow, getCounts, resetCron, holdInitialLoads, releaseInitialLoads } from '$live/cronjobs';

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
		return v.slice().sort((a, b) => String(a.id).localeCompare(String(b.id)));
	}

	function waitOn(store, predicate, timeoutMs = 5000) {
		return new Promise((resolve, reject) => {
			const start = Date.now();
			const check = () => {
				const v = get(store);
				if (predicate(v)) return resolve(v);
				if (Date.now() - start > timeoutMs) {
					return reject(new Error('waitOn timeout: ' + JSON.stringify(v)));
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
				await Promise.all([stats.attach(), feed.attach()]);
			},
			reset: async () => {
				await waitForOpen();
				// Value defaults do not acknowledge an initial loader response.
				// Finish both subscriptions before publishing the reset barrier.
				await Promise.all([stats.attach(), feed.attach()]);
				await resetCron();
				await waitOn(feed, (v) => Array.isArray(v) && v.length === 0);
				await waitOn(stats, (v) => v === null);
				const counts = await getCounts();
				if (counts.ticks !== 0 || counts.itemCount !== 0 || counts.feedCount !== 0) {
					throw new Error('Cron reset did not clear server state: ' + JSON.stringify(counts));
				}
			},
			readStats: () => get(stats),
			readFeed: () => get(feed),
			waitStats: (predicateSrc) => {
				// eslint-disable-next-line no-new-func
				const fn = new Function('v', 'return (' + predicateSrc + ')(v)');
				return waitOn(stats, fn);
			},
			waitFeedCount: (n) => waitOn(feed, (v) => Array.isArray(v) && v.length === n),
			waitFeedIds: (expected) => {
				const want = JSON.stringify(asMultiset(expected.map((id) => ({ id }))).map((x) => x.id));
				return waitOn(feed, (v) => {
					if (!Array.isArray(v)) return false;
					const got = JSON.stringify(asMultiset(v).map((x) => x.id));
					return got === want;
				});
			},
			tickNow: async () => tickNow(),
			getCounts: async () => getCounts(),
			holdInitialLoads: async (userId) => holdInitialLoads(userId),
			releaseInitialLoads: async () => releaseInitialLoads()
		};
		return () => { stats.detach(); feed.detach(); };
	});
</script>

<h1>cron e2e</h1>
<section data-testid="stats">
	{#if $stats}
		<span data-tickcount={$stats.tickCount}>tick={$stats.tickCount}</span>
	{:else}
		<span data-empty="true">no-stats</span>
	{/if}
</section>
<ul data-testid="feed">
	{#each $feed as item (item.id)}
		<li data-id={item.id} data-label={item.label}>{item.id}={item.label}</li>
	{/each}
</ul>
