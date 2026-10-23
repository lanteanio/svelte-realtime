// Checks that fail because of svelte-adapter-uws, not this package. Each entry
// applies only to the adapter version and the runs that reproduce it, and only
// to a failure of one of its checks whose error matches its signature, so an
// unrelated failure in the same check still fails the matrix. Every check runs:
// "restart" starts a fresh server after the failure so the later checks get a
// server the adapter has not broken.

// Shared-state assertions carry SPLIT only when HTTP and WebSocket report
// different instances of the fixture's state module.
export const SPLIT = 'state split between HTTP and WebSocket';
// Assertions that the WebSocket handlers follow a reload carry RELOAD.
export const RELOAD = 'WebSocket handlers did not follow the reload';

export const knownAdapterFailures = [
	{
		adapter: '0.6.0-next.96', runs: /^kit3-dev-hmr-adapter(?:wrapped|none)$/,
		checks: [
			'HTTP and WebSocket share state', 'HMR replaces and removes handlers', 'live stores after HMR',
			'route-only HMR shares HTTP and WebSocket state', 'new live files share HTTP and WebSocket state',
			'removed live files unregister without splitting state', 'broken live modules recover without splitting state',
			'hooks.ws edits keep live handlers and shared state', 'deleted and recreated hooks.ws restore live handlers and shared state'
		],
		signature: SPLIT + '|' + RELOAD, restart: false,
		reason: 'With a wrapped or omitted adapter entry, the SvelteKit 3 dev server and the WebSocket handler load separate module instances'
	},
	{
		adapter: '0.6.0-next.96', runs: /^kit3-dev-hmr(?:-drive-caselower)?$/, checks: ['route-only HMR shares HTTP and WebSocket state'], signature: SPLIT, restart: true,
		reason: 'After a route edit reloads the SvelteKit 3 SSR runner, the adapter does not import the WebSocket handler again, so HTTP and WebSocket state split; whether the reload reaches the handler depends on the order Vite applies it in, so the entry also covers runs that pass'
	},
	{
		// The stale value is part of the signature: a recreated hooks file the
		// adapter never reloads still answers with the edited upgrade data.
		adapter: '0.6.0-next.96', runs: /^kit(?:2|2-vite5|3)-dev-hmr(?:-drive-caselower)?$/, checks: ['deleted and recreated hooks.ws restore live handlers and shared state'],
		signature: RELOAD + ': a new connection did not reach the expected state: connection \\{"id":"[^"]*","ok":true,"data":"compatibility-test-edited"',
		restart: false,
		reason: 'The adapter does not reload src/hooks.ws.js when the file is deleted and created again and keeps serving the previous handler; the watcher event order decides whether it does, so the entry also covers runs that pass'
	}
];

/**
 * The entries for one run of the matrix.
 * @param {string} adapter - Installed svelte-adapter-uws version
 * @param {string} run - Matrix run name
 */
export function entriesFor(adapter, run) {
	return knownAdapterFailures.filter(entry => entry.adapter === adapter && entry.runs.test(run));
}

/**
 * The index of the entry a failed check matches, or -1.
 * @param {Array<{ checks: string[] | null, signature: string }>} entries
 * @param {string} check
 * @param {string} error - The failure's stack or message
 */
export function matchKnown(entries, check, error) {
	return entries.findIndex(entry => (entry.checks === null || entry.checks.includes(check)) && new RegExp(entry.signature).test(error));
}
