import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const runner = fileURLToPath(new URL('./run.mjs', import.meta.url));
const reportDir = path.join(root, 'test-results');
await mkdir(reportDir, { recursive: true });
const runs = [];
const commonChecks = [
	'server startup', 'cold WebSocket RPC before HTTP', 'browser initial live stores',
	'browser RPC roundtrip', 'server-published live stores', 'HTTP and WebSocket share state',
	'devtools runtime', 'browser has no runtime errors', 'no unsupported HTML hook warning'
];

for (const kit of ['2', '3']) {
	for (const variant of [
		{ mode: 'production', args: [] },
		{ mode: 'dev', args: ['--hmr'] },
		{ mode: 'dev', args: ['--no-devtools'] },
		...(kit === '3' ? ['wrapped', 'none'].map(adapter => ({ mode: 'dev', args: ['--hmr', '--adapter', adapter], adapter })) : [])
	]) {
		const name = 'kit' + kit + '-' + variant.mode + variant.args.join('').replaceAll('--', '-');
		const reportPath = path.join(reportDir, 'kit-compat-' + name + '.json');
		const run = { name, reportPath, status: 'failed' };
		console.log('\nRunning ' + name);
		try {
			// Require a report produced by this invocation.
			await unlink(reportPath).catch(error => {
				if (error.code !== 'ENOENT') throw error;
			});
			const child = spawn(process.execPath, [
				runner, '--kit', kit, '--mode', variant.mode, ...variant.args, '--report', reportPath
			], { cwd: root, env: process.env, stdio: 'inherit', windowsHide: true });
			const [code, signal] = await once(child, 'exit');
			run.exitCode = code;
			run.signal = signal;
			const report = JSON.parse(await readFile(reportPath, 'utf8'));
			run.checks = report.checks;
			assert.equal(code, 0, name + ' exited unsuccessfully');
			assert.equal(signal, null, name + ' was terminated');
			assert.equal(report.status, 'passed', name + ' did not pass');
			assert.equal(report.kit, kit);
			assert.equal(report.mode, variant.mode);
			assert.equal(report.hmr, variant.args.includes('--hmr'));
			assert.equal(report.adapterMode, variant.adapter || 'default');
			assert.equal(report.devtools, !variant.args.includes('--no-devtools'));
			const expected = [...commonChecks];
			if (variant.mode === 'production') expected.push('production build');
			if (variant.args.includes('--hmr')) expected.push('HMR replaces and removes handlers', 'live stores after HMR', 'route-only HMR shares HTTP and WebSocket state', 'new live files share HTTP and WebSocket state', 'removed live files unregister without splitting state');
			assert.deepEqual(report.checks.map(check => check.name).sort(), expected.sort(),
				name + ' did not execute exactly the required checks');
			assert.ok(report.checks.every(check => check.status === 'passed'), name + ' contains a failed check');
			run.status = 'passed';
		} catch (error) {
			run.error = error.stack || String(error);
			console.error(run.error);
		}
		runs.push(run);
	}
}
const status = runs.every(run => run.status === 'passed') ? 'passed' : 'failed';
const reportPath = path.join(reportDir, 'kit-compat-matrix.json');
await writeFile(reportPath, JSON.stringify({ status, runs }, null, 2) + '\n');
console.log('\nCompatibility matrix: ' + status + ' (' + runs.filter(run => run.status === 'passed').length + '/8)');
console.log('Report: ' + reportPath);
if (status !== 'passed') process.exitCode = 1;
