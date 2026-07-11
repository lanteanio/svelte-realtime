#!/usr/bin/env node
/**
 * Guard that every tracked .js/.mjs file is valid JavaScript to NATIVE Node
 * (the declared runtime), not merely to Vitest's transform pipeline. The
 * transform layer tolerates constructs the engine rejects - a duplicate
 * import binding, for instance - so a suite can be green over source that
 * `node --check`, editors, and other tooling refuse to parse.
 *
 * One process parses everything: each file is compiled as an ES module via
 * vm.SourceTextModule (construction parses without linking or executing).
 * Dependency-free, modeled on the sibling check-determinism / check-types
 * scripts, wired into pretest.
 *
 * Invoke as: node --no-warnings --experimental-vm-modules scripts/check-syntax.js
 * (the flag only enables the parser entry point; nothing is evaluated).
 *
 * @module scripts/check-syntax
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import vm from 'node:vm';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

if (typeof vm.SourceTextModule !== 'function') {
	console.error('check-syntax: run with --experimental-vm-modules (see the check script)');
	process.exit(1);
}

// Tracked files only - generated fixtures and installed dependencies are
// hands-off; whatever git owns must parse.
const files = execFileSync('git', ['ls-files', '*.js', '*.mjs'], { cwd: root, encoding: 'utf8' })
	.split('\n')
	.filter(Boolean);

let failures = 0;
for (const file of files) {
	const source = readFileSync(resolve(root, file), 'utf8');
	try {
		new vm.SourceTextModule(source, { identifier: file });
	} catch (err) {
		failures++;
		console.error(`check-syntax: ${file}: ${err.message}`);
	}
}

if (failures > 0) {
	console.error(`check-syntax: ${failures} of ${files.length} tracked JS files do not parse as native ES modules`);
	process.exit(1);
}
console.log(`check-syntax: ${files.length} tracked JS files parse natively`);
