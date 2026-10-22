import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: { include: ['test/scaffold-counter.browser.js', 'test/scaffold-counter-live.browser.js'], fileParallelism: false, reporters: ['verbose'] }
});
