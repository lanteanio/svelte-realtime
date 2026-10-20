import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';
import adapter from 'svelte-adapter-uws';
import uws from 'svelte-adapter-uws/vite';
import realtime from 'svelte-realtime/vite';
const adapterMode = process.env.KIT_COMPAT_ADAPTER || 'default';
const configuredAdapter = adapter({ websocket: { allowedOrigins: '*', upgradeRateLimit: 1000 } });
if (adapterMode === 'wrapped') configuredAdapter.name = 'custom-adapter';
export default defineConfig({
	plugins: [
		sveltekit(adapterMode === 'none' ? {} : { adapter: configuredAdapter }), uws(), realtime({ devtools: process.env.KIT_COMPAT_DEVTOOLS !== 'false' }),
		{ name: 'kit-compat-root', configResolved(config) { if (process.env.KIT_COMPAT_REPORT_ROOT === 'true') console.log('[kit-compat] vite root ' + config.root); } }
	],
	resolve: { dedupe: ['svelte', 'svelte-adapter-uws'] }
});
