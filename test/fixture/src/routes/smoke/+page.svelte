<script>
	import { onMount } from 'svelte';
	import { get } from 'svelte/store';
	import { echo } from '$live/echo';
	import { todos, publishExternal, reset } from '$live/todos';

	let payload = $state('hello');
	let echoResult = $state('');

	function waitForTodos(predicate, timeoutMs = 5000) {
		return new Promise((resolve, reject) => {
			const start = Date.now();
			const check = () => {
				const v = get(todos);
				if (predicate(v)) return resolve(v);
				if (Date.now() - start > timeoutMs) {
					return reject(new Error('waitForTodos timeout: ' + JSON.stringify(v)));
				}
				setTimeout(check, 20);
			};
			check();
		});
	}

	onMount(() => {
		// @ts-ignore -- test-only API
		window.__test = {
			reset: async () => {
				await reset();
				await waitForTodos((v) => Array.isArray(v) && v.length === 0);
			},
			callEcho: async (p) => {
				const r = await echo({ payload: p });
				echoResult = JSON.stringify(r);
				return r;
			},
			publishOne: async () => {
				await publishExternal({ event: 'created', data: { id: 's1', name: 'smoke' } });
				return waitForTodos((v) => Array.isArray(v) && v.some((t) => t.id === 's1'));
			}
		};
	});
</script>

<h1>smoke e2e</h1>
<p data-testid="echo-result">{echoResult}</p>

<h2>todos stream</h2>
<ul data-testid="todos">
	{#each $todos as t (t.id)}
		<li data-id={t.id} data-name={t.name}>{t.id}={t.name}</li>
	{/each}
</ul>
