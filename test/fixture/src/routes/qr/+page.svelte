<script>
	import { onMount } from 'svelte';
	import { get } from 'svelte/store';
	import { status } from 'svelte-adapter-uws/client';
	import { todos, ok, okWithPublish, fail, block, release, publishExternal, reset } from '$live/todos';

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
				const v = get(todos);
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

	/** Pending mutate promises keyed by token. */
	const _pending = new Map();

	function startBlocked({ token, kind, id, name }) {
		// Returns immediately. The mutate's asyncOp is `block({token})` which
		// only settles when `release({token, success})` is called. The
		// returned promise is stashed in _pending so release() can await it
		// to ensure the client-side settle (queue removal + display refresh)
		// has completed before the test reads the next state.
		let optimisticChange;
		if (kind === 'create') optimisticChange = { event: 'created', data: { id, name } };
		else if (kind === 'update') optimisticChange = { event: 'updated', data: { id, name } };
		else if (kind === 'ff') optimisticChange = (cur) => [...cur, { id, name: 'ff:' + name }];
		else throw new Error('unknown kind: ' + kind);

		const p = todos.mutate(() => block({ token }), optimisticChange).then(
			(v) => ({ ok: true, v }),
			(e) => ({ ok: false, code: e?.code, message: e?.message })
		);
		_pending.set(token, p);
	}

	async function releaseToken({ token, success }) {
		await release({ token, success });
		const p = _pending.get(token);
		if (p) {
			_pending.delete(token);
			return p;
		}
		return null;
	}

	onMount(() => {
		// @ts-ignore
		window.__test = {
			ready: async () => {
				// Resolves when the WS is open AND the initial stream fetch
				// has populated the store. Multi-page tests open several
				// browser contexts in quick succession; on prod the server
				// may take longer to handshake, and reading the store
				// before initial fetch returns gives `undefined` and trips
				// downstream predicates.
				await waitForOpen();
				await waitFor((v) => Array.isArray(v));
			},
			reset: async () => {
				await waitForOpen();
				await reset();
				await waitFor((v) => Array.isArray(v) && v.length === 0);
				// Allow any in-flight refreshed:[] frames from the reset's
				// ctx.publish to drain. uws may batch / cork the publish
				// frame so it arrives later than the RPC response, even
				// though both ride the same WS connection. Without this
				// wait, a delayed refreshed:[] can land mid-test and
				// silently clobber the displayed list.
				await new Promise((r) => setTimeout(r, 100));
			},
			todos: () => get(todos),
			waitTodos: (expected) => waitFor(sameAs(expected)),
			startBlocked,
			release: releaseToken,
			mutateOk: async ({ id, name }) => {
				return todos.mutate(
					() => ok({ id, name }),
					{ event: 'created', data: { id, name } }
				);
			},
			mutateOkPublish: async ({ id, name }) => {
				return todos.mutate(
					() => okWithPublish({ id, name }),
					{ event: 'created', data: { id, name } }
				);
			},
			mutateFail: async ({ id, name }) => {
				try {
					await todos.mutate(
						() => fail(),
						{ event: 'created', data: { id, name } }
					);
					return { ok: true };
				} catch (err) {
					return { ok: false, code: err?.code, message: err?.message };
				}
			},
			publish: async ({ event, id, name }) => {
				await publishExternal({ event, data: { id, name } });
				// Wait for the published frame to land on the client (uws
				// frame-batching can stagger publish vs RPC response). The
				// caller typically follows up with waitTodos for the new
				// state, so this is just a small drain budget.
				await new Promise((r) => setTimeout(r, 50));
			}
		};
	});
</script>

<h1>queue-replay e2e</h1>
<ul data-testid="todos">
	{#each $todos as t (t.id)}
		<li data-id={t.id} data-name={t.name}>{t.id}={t.name}</li>
	{/each}
</ul>
