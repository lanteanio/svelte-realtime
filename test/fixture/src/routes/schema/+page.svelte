<script>
	import { onMount } from 'svelte';
	import { status } from 'svelte-adapter-uws/client';
	import { submitForm, submitNested } from '$live/schema';

	let lastResult = $state('');

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

	async function call(fn, payload) {
		try {
			const v = await fn(payload);
			lastResult = JSON.stringify(v);
			return { ok: true, v };
		} catch (err) {
			lastResult = JSON.stringify({ code: err && err.code, message: err && err.message });
			return { ok: false, code: err && err.code, message: err && err.message, issues: err && err.issues };
		}
	}

	onMount(() => {
		// @ts-ignore -- test-only API
		window.__test = {
			ready: () => waitForOpen(),
			submitFlat: (payload) => call(submitForm, payload),
			submitNested: (payload) => call(submitNested, payload)
		};
	});
</script>

<h1>schema-validation e2e</h1>
<p data-testid="last-result">{lastResult}</p>
