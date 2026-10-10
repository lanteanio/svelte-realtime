import { spawn, execFileSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chaosRun, composeArgs, readContext } from '../test/chaos/run-context.js';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runs = [chaosRun({}), chaosRun({})];
const trackedDiff = () => execFileSync('git', ['diff', '--binary', 'HEAD', '--'], { cwd: repository, encoding: 'utf8' });
const before = trackedDiff();
const children = runs.map((run) => {
	console.log('Parallel chaos run ' + run.id + ': ' + run.directory);
	const child = spawn(process.execPath, [
		path.join(repository, 'node_modules/@playwright/test/cli.js'), 'test',
		'--config', 'test/chaos/playwright.config.js',
		'--grep', 'cross-instance channel publish:', '--reporter=line'
	], {
		cwd: repository,
		stdio: ['ignore', 'inherit', 'inherit'],
		env: { ...process.env, REALTIME_CHAOS_RUN_ID: run.id, REALTIME_CHAOS_WAIT_FOR_START: '1' }
	});
	const finished = new Promise((resolve) => {
		child.once('error', (error) => resolve({ code: null, error: error.message }));
		child.once('close', (code, signal) => resolve({ code, signal }));
	});
	return { child, finished };
});

let readinessError;
try {
	const deadline = Date.now() + 180_000;
	for (;;) {
		const contexts = runs.map((run) => {
			try { return readContext(run); } catch { return null; }
		});
		if (contexts.every((context) => context?.ready)) {
			const ports = contexts.flatMap((context) => [context.redisPort, context.portA, context.portB]);
			if (new Set(ports).size !== ports.length) throw new Error('Concurrent chaos runs shared a service port');
			const pids = contexts.flatMap((context) => context.ownedProcesses.map((record) => record.pid));
			if (pids.length !== 4 || new Set(pids).size !== 4) throw new Error('Concurrent chaos runs shared an instance');
			console.log('Both private fixtures are serving simultaneously on six distinct ports.');
			break;
		}
		if (children.some(({ child }) => child.exitCode !== null || child.signalCode !== null)) throw new Error('A chaos run exited before concurrent readiness');
		if (Date.now() >= deadline) throw new Error('Concurrent chaos runs did not become ready');
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
} catch (error) {
	readinessError = error;
} finally {
	// Let either ready run complete its ordinary teardown even if its peer failed.
	for (const run of runs) if (existsSync(run.directory)) writeFileSync(path.join(run.directory, 'start'), 'start');
}
const results = await Promise.all(children.map(({ finished }) => finished));
if (readinessError) throw readinessError;
if (results.some(({ code }) => code !== 0)) throw new Error('A parallel chaos invocation failed: ' + JSON.stringify(results));
for (const run of runs) {
	if (existsSync(run.directory)) throw new Error('Chaos invocation retained its temporary fixture: ' + run.directory);
	const containers = execFileSync('docker', composeArgs(run, ['ps', '-aq']), {
		cwd: repository, encoding: 'utf8', env: { ...process.env, CHAOS_REDIS_PORT: '0' }
	}).trim();
	if (containers) throw new Error('Chaos invocation retained containers: ' + containers);
}
if (trackedDiff() !== before) throw new Error('Parallel chaos runs modified tracked repository files');
console.log('Both parallel chaos invocations passed, removed their owned resources, and left tracked files unchanged.');
