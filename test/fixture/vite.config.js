import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';
import uws from 'svelte-adapter-uws/vite';
import realtime from 'svelte-realtime/vite';

export default defineConfig({
	cacheDir: process.env.REALTIME_CHAOS_FIXTURE ? process.env.REALTIME_CHAOS_FIXTURE + '/.vite' : undefined,
	plugins: [sveltekit(), uws(), realtime()]
});
