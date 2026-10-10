import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: { include: ['test/scaffold-counter.browser.js'], fileParallelism: false, reporters: ['verbose'] }
});
