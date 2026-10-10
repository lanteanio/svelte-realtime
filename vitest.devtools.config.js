import { defineConfig } from 'vitest/config';

export default defineConfig({
 test: { include: ['test/devtools-ui.browser.js'], fileParallelism: false, reporters: ['verbose'] }
});
