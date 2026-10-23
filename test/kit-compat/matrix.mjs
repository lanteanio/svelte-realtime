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
	'server startup', 'cold WebSocket RPC before any page load', 'browser initial live stores',
	'browser RPC roundtrip', 'server-published live stores', 'HTTP and WebSocket share state',
	'devtools runtime', 'browser has no runtime errors', 'no unsupported HTML hook warning'
];
// Checks that fail because of svelte-adapter-uws, not this package. Each entry
// applies only to the adapter version that reproduces it, so an upgraded
// fixture runs the check as an ordinary one again. They are reported as known
// adapter failures; a "stop" entry ends the run, and the checks it did not
// reach are listed.
const knownAdapterFailures = [
	{
		adapter: '0.6.0-next.96', runs: /^kit3-dev-hmr-adapter(?:wrapped|none)$/, check: 'HTTP and WebSocket share state', after: 'stop',
		reason: 'With a wrapped or omitted adapter entry, the SvelteKit 3 dev server and the WebSocket handler load separate module instances'
	},
	{
		adapter: '0.6.0-next.96', runs: /^kit3-dev-hmr(?:-drive-caselower)?$/, check: 'route-only HMR shares HTTP and WebSocket state', after: 'stop',
		reason: 'After a route edit reloads the SvelteKit 3 SSR runner, the adapter does not import the WebSocket handler again, so HTTP and WebSocket state split'
	},
	{
		adapter: '0.6.0-next.96', runs: /-dev-hmr/, check: 'deleted and recreated hooks.ws restore live handlers and shared state', after: 'continue',
		reason: 'The adapter does not reload src/hooks.ws.js when the file is deleted and created again; it keeps serving the previous handler'
	}
];
async function installedAdapter(fixtureName) {
	const manifest = path.join(root, 'test', 'fixtures', fixtureName, 'node_modules', 'svelte-adapter-uws', 'package.json');
	return JSON.parse(await readFile(manifest, 'utf8')).version;
}

// Kit 2 also runs on Vite 5, which its peer range still admits.
for (const [kit, vite] of [['2', 'locked'], ['2', '5'], ['3', 'locked']]) {
	for (const variant of vite === '5' ? [
		{ mode: 'production', args: [] },
		{ mode: 'dev', args: ['--hmr'] }
	] : [
		{ mode: 'production', args: [] },
		{ mode: 'dev', args: ['--hmr'] },
		{ mode: 'dev', args: ['--no-devtools'] },
		...(kit === '3' ? ['wrapped', 'none'].map(adapter => ({ mode: 'dev', args: ['--hmr', '--adapter', adapter], adapter })) : []),
		...(kit === '3' && process.platform === 'win32' ? [
			{ mode: 'production', args: ['--drive-case', 'lower'], driveCase: 'lower' },
			{ mode: 'dev', args: ['--hmr', '--drive-case', 'lower'], driveCase: 'lower' }
		] : [])
	]) {
		const name = 'kit' + kit + (vite === '5' ? '-vite5' : '') + '-' + variant.mode + variant.args.join('').replaceAll('--', '-');
		const reportPath = path.join(reportDir, 'kit-compat-' + name + '.json');
		const run = { name, reportPath, status: 'failed' };
		console.log('\nRunning ' + name);
		try {
			const adapter = await installedAdapter('kit' + kit + (vite === '5' ? '-vite5' : ''));
			const known = knownAdapterFailures.filter(entry => entry.adapter === adapter && entry.runs.test(name));
			// Require a report produced by this invocation.
			await unlink(reportPath).catch(error => {
				if (error.code !== 'ENOENT') throw error;
			});
			const child = spawn(process.execPath, [
				runner, '--kit', kit, '--vite', vite, '--mode', variant.mode, ...variant.args, '--report', reportPath,
				...known.flatMap(entry => ['--known-adapter-failure', entry.after + ':' + entry.check])
			], { cwd: root, env: process.env, stdio: 'inherit', windowsHide: true });
			const [code, signal] = await once(child, 'exit');
			run.exitCode = code;
			run.signal = signal;
			const report = JSON.parse(await readFile(reportPath, 'utf8'));
			run.checks = report.checks;
			assert.equal(code, 0, name + ' exited unsuccessfully');
			assert.equal(signal, null, name + ' was terminated');
			assert.ok(['passed', 'known-adapter-failure'].includes(report.status), name + ' did not pass');
			assert.equal(report.kit, kit);
			if (vite === '5') assert.match(report.vite, /^5\./, name + ' did not run Vite 5');
			assert.equal(report.mode, variant.mode);
			assert.equal(report.hmr, variant.args.includes('--hmr'));
			assert.equal(report.adapterMode, variant.adapter || 'default');
			assert.equal(report.devtools, !variant.args.includes('--no-devtools'));
			assert.equal(report.driveCase, variant.driveCase || 'as-invoked');
			const expected = [...commonChecks];
			if (variant.mode === 'production') expected.push('production build');
			if (variant.driveCase) expected.push('Vite and SvelteKit spell the root differently');
			if (variant.args.includes('--hmr')) expected.push('HMR replaces and removes handlers', 'live stores after HMR', 'one registry reload per live-file save', 'route-only HMR shares HTTP and WebSocket state', 'new live files share HTTP and WebSocket state', 'removed live files unregister without splitting state', 'broken live modules recover without splitting state', 'hooks.ws edits keep live handlers and shared state', 'deleted and recreated hooks.ws restore live handlers and shared state', 'HMR emits no Cloudflare Tunnel warning');
			const knownFor = check => known.find(entry => entry.check === check.name);
			assert.ok(report.checks.every(check => check.status === 'passed' || (check.status === 'known-adapter-failure' && knownFor(check))),
				name + ' contains a failed check');
			const hit = report.checks.filter(check => check.status === 'known-adapter-failure');
			const executed = report.checks.map(check => check.name);
			if (hit.some(check => knownFor(check).after === 'stop')) {
				assert.ok(executed.every(check => expected.includes(check)), name + ' executed an unexpected check');
				run.notReached = expected.filter(check => !executed.includes(check));
			} else {
				assert.deepEqual([...executed].sort(), expected.sort(), name + ' did not execute exactly the required checks');
			}
			run.knownAdapterFailures = hit.map(check => ({ check: check.name, adapter, reason: knownFor(check).reason }));
			// A known failure that passed is reported so the entry can be removed once
			// the adapter is fixed; some of them reproduce on most runs, not all.
			run.knownFailuresNotReproduced = known.filter(entry => report.checks.some(check => check.name === entry.check && check.status === 'passed')).map(entry => entry.check);
			run.status = hit.length ? 'known-adapter-failure' : 'passed';
		} catch (error) {
			run.error = error.stack || String(error);
			console.error(run.error);
		}
		runs.push(run);
	}
}
const failed = runs.some(run => run.status === 'failed');
const withKnown = runs.filter(run => run.status === 'known-adapter-failure');
const status = failed ? 'failed' : withKnown.length ? 'passed-with-known-adapter-failures' : 'passed';
const reportPath = path.join(reportDir, 'kit-compat-matrix.json');
await writeFile(reportPath, JSON.stringify({ status, runs }, null, 2) + '\n');
console.log('\nCompatibility matrix: ' + status + ' (' + runs.filter(run => run.status === 'passed').length + '/' + runs.length + ' passed, '
	+ withKnown.length + ' with known adapter failures)');
for (const run of withKnown) {
	for (const entry of run.knownAdapterFailures) {
		console.log('  known adapter failure (svelte-adapter-uws ' + entry.adapter + ') in ' + run.name + ': ' + entry.check + '. ' + entry.reason);
	}
	if (run.notReached?.length) console.log('    not reached: ' + run.notReached.join(', '));
}
for (const run of runs) {
	if (run.knownFailuresNotReproduced?.length) console.log('  known adapter failure passed in ' + run.name + ': ' + run.knownFailuresNotReproduced.join(', '));
}
console.log('Report: ' + reportPath);
if (failed) process.exitCode = 1;
