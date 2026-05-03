<script>
	import { onMount } from 'svelte';
	import { status } from 'svelte-adapter-uws/client';
	import { ordered, bounded, readLog, resetLog } from '$live/lock';

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

	onMount(() => {
		// @ts-ignore
		window.__test = {
			ready: () => waitForOpen(),
			reset: async () => {
				await waitForOpen();
				await resetLog();
			},
			readLog: async () => {
				const r = await readLog();
				return r.log;
			},
			fireThreeOrdered: async (holdMs) => {
				await Promise.all([
					ordered({ name: 'alpha', holdMs }),
					ordered({ name: 'beta', holdMs }),
					ordered({ name: 'gamma', holdMs })
				]);
				const r = await readLog();
				return r.log;
			},
			fireBoundedContended: async (holdMs) => {
				const settled = await Promise.all([
					bounded({ name: 'holder', holdMs }).then((v) => ({ ok: true, v }), (e) => ({ ok: false, code: e?.code, message: e?.message })),
					bounded({ name: 'waiter', holdMs }).then((v) => ({ ok: true, v }), (e) => ({ ok: false, code: e?.code, message: e?.message }))
				]);
				return settled;
			}
		};
	});
</script>

<h1>lock e2e</h1>
<p data-testid="ready">ready</p>
