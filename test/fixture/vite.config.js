import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';
import uws from 'svelte-adapter-uws/vite';
import realtime from 'svelte-realtime/vite';

export default defineConfig({
	plugins: [sveltekit(), uws(), realtime()]
});
