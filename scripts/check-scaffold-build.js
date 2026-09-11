#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderViteConfig } from '../src/cli-utils.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixture = join(root, 'test', 'fixture');
const config = join(root, 'scripts', '.scaffold-build-' + process.pid + '.mjs');
const vite = join(root, 'node_modules', 'vite', 'bin', 'vite.js');
const output = join(fixture, 'build');
const entry = join(output, 'index.js');

try {
	// This is the adapter output directory for this exact fixture, resolved from
	// literals above. Remove it before the build so stale output can never make a
	// successful adapter-auto build look like a runnable adapter-uws build.
	if (dirname(output) !== fixture) throw new Error('refusing to clean an unexpected build path');
	rmSync(output, { recursive: true, force: true });
	const startedAt = Date.now();
	writeFileSync(config, renderViteConfig());
	const result = spawnSync(process.execPath, [vite, 'build', '--config', config], {
		cwd: fixture,
		encoding: 'utf8',
		env: { ...process.env, NODE_ENV: 'production' }
	});
	if (result.status !== 0) {
		process.stderr.write(result.stdout || '');
		process.stderr.write(result.stderr || '');
		process.exitCode = result.status || 1;
	} else if (!existsSync(entry) || statSync(entry).mtimeMs < startedAt - 1000) {
		console.error('check-scaffold-build FAILED: generated config produced no build/index.js');
		process.exitCode = 1;
	} else {
		console.log('check-scaffold-build: generated current-sv config produced build/index.js');
	}
} finally {
	rmSync(config, { force: true });
}
