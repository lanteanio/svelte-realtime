import { defineConfig } from '@playwright/test';
import { DEV_PORT, PROD_PORT } from './ports.js';

// Each spec runs twice: once against the Vite dev server and once
// against the built production server (svelte-adapter-uws output via
// `node build/index.js`). The build path catches issues that don't
// surface in dev (Vite SSR transforms, bundling, codegen pre-warm,
// adapter packaging) and proves the realtime layer behaves
// identically when the SvelteKit page is statically built and served
// by the prod server.

const projects = [];
const specs = ['queue-replay.spec.js', 'lock.spec.js', 'smoke.spec.js', 'multi-page.spec.js', 'reconnect.spec.js', 'multi-page-auth.spec.js'];
for (const spec of specs) {
	const baseName = spec.replace('.spec.js', '');
	projects.push({
		name: `${baseName}-dev`,
		testMatch: spec,
		use: { baseURL: `http://localhost:${DEV_PORT}` }
	});
	projects.push({
		name: `${baseName}-prod`,
		testMatch: spec,
		use: { baseURL: `http://localhost:${PROD_PORT}` }
	});
}

export default defineConfig({
	testDir: '.',
	timeout: 30000,
	retries: 0,
	workers: 1,
	globalSetup: './global-setup.js',
	globalTeardown: './global-teardown.js',
	use: { headless: true },
	projects
});
