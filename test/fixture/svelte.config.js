import adapter from 'svelte-adapter-uws';

export default {
	kit: {
		adapter: adapter({
			websocket: {
				allowedOrigins: '*',
				// Multi-page e2e opens many BrowserContexts in quick
				// succession; each has its own WS connection. Bump the
				// upgrade rate limit so the prod server does not throttle
				// or drop incoming connections during the test sweep.
				upgradeRateLimit: 1000
			}
		})
	}
};
