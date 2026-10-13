import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		include: ['test/**/*.test.js'],
		fileParallelism: false,
		isolate: true,
		reporters: ['verbose'],
		// Load the adapter through Vite so vi.resetModules() gives each test a
		// fresh client. An externalized copy is shared by every test in a file,
		// and since a closed connection no longer reopens on store access, one
		// test's close() would leave the next test a dead client.
		server: { deps: { inline: ['svelte-adapter-uws'] } }
	}
});
