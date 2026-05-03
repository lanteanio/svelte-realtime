<script>
	import { onMount } from 'svelte';
	import { get } from 'svelte/store';
	import { status } from 'svelte-adapter-uws/client';
	import {
		dashboardStats,
		debouncedStats,
		orgStats,
		incOrders,
		incUsers,
		incOrdersBurst,
		publishOrgSource,
		getRecomputeCounts,
		resetDerived
	} from '$live/derived';

	const org1 = orgStats('o1');
	const org2 = orgStats('o2');

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
			ready: async () => {
				await waitForOpen();
				// Subscribing to all three streams forces initial fetch + derived activation.
				await waitForStore(dashboardStats, (v) => v != null);
				await waitForStore(debouncedStats, (v) => v != null);
				await waitForStore(org1, (v) => v != null);
				await waitForStore(org2, (v) => v != null);
			},
			reset: async () => {
				await waitForOpen();
				await resetDerived();
				// Wait for the post-reset recompute to flush and the counters to drop to 0.
				await waitForStore(dashboardStats, (v) => v && v.orders === 0 && v.users === 0);
				await waitForStore(debouncedStats, (v) => v && v.orders === 0 && v.users === 0, 2000);
				// Drain any late frames before the test starts asserting.
				await new Promise((r) => setTimeout(r, 250));
			},
			readDashboard: () => get(dashboardStats),
			readDebounced: () => get(debouncedStats),
			readOrg1: () => get(org1),
			readOrg2: () => get(org2),
			waitDashboard: (predicateSrc) => waitForStore(dashboardStats, new Function('v', 'return ' + predicateSrc)),
			waitDebounced: (predicateSrc, timeoutMs) => waitForStore(debouncedStats, new Function('v', 'return ' + predicateSrc), timeoutMs),
			waitOrg1: (predicateSrc) => waitForStore(org1, new Function('v', 'return ' + predicateSrc)),
			waitOrg2: (predicateSrc) => waitForStore(org2, new Function('v', 'return ' + predicateSrc)),
			incOrders: () => incOrders(),
			incUsers: () => incUsers(),
			incOrdersBurst: (n) => incOrdersBurst({ n }),
			publishOrgSource: (orgId, kind) => publishOrgSource({ orgId, kind: kind || 'memberships' }),
			getCounts: () => getRecomputeCounts(),
			sleep: (ms) => new Promise((r) => setTimeout(r, ms))
		};
	});
</script>

<h1>derived e2e</h1>
<pre data-testid="dashboard">{JSON.stringify($dashboardStats)}</pre>
<pre data-testid="debounced">{JSON.stringify($debouncedStats)}</pre>
<pre data-testid="org1">{JSON.stringify($org1)}</pre>
<pre data-testid="org2">{JSON.stringify($org2)}</pre>
