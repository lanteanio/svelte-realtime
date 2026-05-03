import { defineConfig } from '@playwright/test';

// Tier-4 chaos suite: two svelte-realtime instances connected to a
// shared Redis pubsub bus. The actual instance host ports are picked
// at globalSetup time and stashed on globalThis so specs read them
// from there rather than a hardcoded constant. The baseURL field is
// not used directly (specs build their own URLs per-instance via
// `globalThis.__chaosCtx.portA / portB`).

export default defineConfig({
	testDir: '.',
	timeout: 60_000,
	retries: 0,
	workers: 1,
	globalSetup: './global-setup.js',
	globalTeardown: './global-teardown.js',
	use: { headless: true },
	projects: [
		{ name: 'chaos', testMatch: 'multi-instance.spec.js' }
	]
});
