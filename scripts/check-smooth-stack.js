import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporary = mkdtempSync(path.join(tmpdir(), 'realtime-smooth-stack-'));
const npm = process.env.npm_execpath || path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
const vitest = path.join(root, 'node_modules/vitest/vitest.mjs');
let dependencies;
function run(label, adapterRoot) {
	const env = { ...process.env };
	delete env.REALTIME_SMOOTH_LEGACY_ROOT;
	if (adapterRoot) env.REALTIME_SMOOTH_LEGACY_ROOT = adapterRoot;
	const report = path.join(temporary, label + '.json');
	execFileSync(process.execPath, [vitest, 'run', 'test/smooth-installed-batch.test.js', '--reporter=json', '--outputFile=' + report], {
		cwd: root, env, stdio: 'inherit', timeout: 60_000
	});
	const result = JSON.parse(readFileSync(report, 'utf8'));
	assert.equal(result.success, true);
	assert.equal(result.numTotalTests, 2);
	assert.equal(result.numPassedTests, 2);
	assert.equal(result.numPendingTests, 0, 'native integration must run, never skip');
	console.log('Smooth real-socket matrix: ' + label + ' passed both delivery paths.');
}
try {
	run('installed');
	const packed = JSON.parse(execFileSync(process.execPath, [npm, 'pack', 'svelte-adapter-uws@0.6.0-next.61', '--ignore-scripts', '--json', '--pack-destination', temporary], {
		cwd: root, encoding: 'utf8', timeout: 90_000
	}))[0];
	assert.equal(packed.version, '0.6.0-next.61');
	assert.equal(packed.shasum, 'd9261c5faad6a737ed62a67174fcd88edda6aad3');
	const archive = path.join(temporary, packed.filename);
	const paths = execFileSync('tar', ['-tf', archive], { encoding: 'utf8' }).trim().split(/\r?\n/);
	assert(paths.every(entry => entry.startsWith('package/') && !entry.split('/').includes('..')), 'package extraction stays inside its owned directory');
	execFileSync('tar', ['-xf', archive, '-C', temporary], { timeout: 30_000 });
	const adapterRoot = path.join(temporary, 'package');
	// Reuse only native/peer dependencies. The adapter implementation and codecs
	// come from the historical archive; the supported installed floor stays intact.
	dependencies = path.join(adapterRoot, 'node_modules');
	symlinkSync(path.join(root, 'node_modules'), dependencies, process.platform === 'win32' ? 'junction' : 'dir');
	run('next.61', adapterRoot);
} finally {
	// Unlink the shared dependency junction before deleting the owned temp root.
	if (dependencies) { try { unlinkSync(dependencies); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
	assert.equal(path.dirname(path.resolve(temporary)), path.resolve(tmpdir()));
	assert(path.basename(temporary).startsWith('realtime-smooth-stack-'));
	rmSync(temporary, { recursive: true, force: true });
}
