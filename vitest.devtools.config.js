import { defineConfig } from 'vitest/config';

export default defineConfig({
 test: { include: ['test/devtools-ui.browser.js', 'test/devtools-live-smooth.browser.js', 'test/devtools-environment.browser.js'], fileParallelism: false, reporters: ['verbose'] }
});
