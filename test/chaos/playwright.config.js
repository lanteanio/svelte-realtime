import { defineConfig } from '@playwright/test';
import { chaosRun } from './run-context.js';

const run = chaosRun();

// Host ports and cleanup records live in the invocation's private context.
// Each worker inherits its run identifier from this configuration process.

export default defineConfig({
	testDir: '.',
	timeout: 120_000,
	retries: 0,
	workers: 1,
	outputDir: run.results,
	globalSetup: './global-setup.js',
	globalTeardown: './global-teardown.js',
	use: { headless: true },
	projects: [
		{
			name: 'chaos',
			testMatch: ['multi-instance.spec.js', 'recovery.spec.js', 'room-lobby-cluster.spec.js', 'presence-erasure.spec.js']
		}
	]
});
