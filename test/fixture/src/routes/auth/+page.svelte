<script>
	import { onMount } from 'svelte';
	import { get } from 'svelte/store';
	import { status } from 'svelte-adapter-uws/client';
	import { whoami, inbox as inboxFor, sendToInbox, adminAction, resetAuth } from '$live/auth';

	// `inbox` is a dynamic stream (topic derived from ctx.user.id on the
	// server), so the client export is a factory that returns a store.
	// Call it with no args -- the server resolves the topic.
	const inbox = inboxFor();

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

	function waitFor(predicate, timeoutMs = 5000) {
		return new Promise((resolve, reject) => {
			const start = Date.now();
			const check = () => {
				const v = get(inbox);
				if (predicate(v)) return resolve(v);
				if (Date.now() - start > timeoutMs) {
					return reject(new Error('waitFor timeout: ' + JSON.stringify(v)));
				}
				setTimeout(check, 20);
			};
			check();
		});
	}

	function asMultiset(v) {
		if (!Array.isArray(v)) return null;
		return v.slice().sort((a, b) => String(a.id).localeCompare(String(b.id)));
	}

	function sameAs(expected) {
		return (v) => JSON.stringify(asMultiset(v)) === JSON.stringify(asMultiset(expected));
	}

	onMount(() => {
		// @ts-ignore
		window.__test = {
			ready: async () => {
				await waitForOpen();
				await waitFor((v) => Array.isArray(v));
			},
			reset: async () => {
				await waitForOpen();
				await resetAuth();
				await waitFor((v) => Array.isArray(v) && v.length === 0);
				// Drain late refreshed:[] frames (uws frame batching can
				// stagger publish vs RPC response).
				await new Promise((r) => setTimeout(r, 100));
			},
			whoami: async () => whoami(),
			inbox: () => get(inbox),
			waitInbox: (expected) => waitFor(sameAs(expected)),
			send: async ({ to, text }) => {
				const r = await sendToInbox({ to, text });
				return r;
			},
			callAdmin: async () => {
				try {
					return { ok: true, v: await adminAction() };
				} catch (err) {
					return { ok: false, code: err && err.code, message: err && err.message };
				}
			}
		};
	});
</script>

<h1>auth e2e</h1>
<ul data-testid="inbox">
	{#each $inbox as msg (msg.id)}
		<li data-id={msg.id} data-from={msg.from}>{msg.from}: {msg.text}</li>
	{/each}
</ul>
