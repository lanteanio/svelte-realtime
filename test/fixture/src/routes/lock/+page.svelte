<script>
	import { onMount } from 'svelte';
	import { status } from 'svelte-adapter-uws/client';
	import { ordered, bounded, readLog, resetLog } from '$live/lock';

	onMount(() => {
		// @ts-ignore
		window.__test = {
			reset: async () => {
				// Wait for the WS connection to be fully open before issuing
				// the first RPC. The lock page has no stream subscription to
				// keep the connection warm, so the very first RPC after
				// page.goto can race the WS handshake (visible as a
				// transient DISCONNECTED on the prod server's first call).
				await new Promise((resolve) => {
					const unsub = status.subscribe((s) => {
						if (s === 'open') { unsub(); resolve(); }
					});
				});
				await resetLog();
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
