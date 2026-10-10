import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceFixture = path.join(repository, 'test/fixture');
const dependencies = path.join(sourceFixture, 'node_modules');
if (!existsSync(dependencies)) throw new Error('Install fixture dependencies first: npm ci --prefix test/fixture');
const WebSocket = createRequire(path.join(sourceFixture, 'package.json'))('ws');
const npm = process.env.npm_execpath || path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
const temporary = mkdtempSync(path.join(tmpdir(), 'realtime-production-lifecycle-'));
const fixture = path.join(temporary, 'fixture');
const containers = new Set();
const image = process.env.REALTIME_LIFECYCLE_NODE_IMAGE || 'node:24.13.1-trixie-slim';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function docker(...args) {
	return execFileSync('docker', args, { encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function removeContainer(name) {
	try { docker('rm', '--force', name); }
	catch (error) {
		if (!String(error.stderr).includes('No such container')) throw error;
	}
	containers.delete(name);
}

function logs(name) {
	const result = spawnSync('docker', ['logs', name], { encoding: 'utf8', timeout: 5000 });
	return (result.stdout || '') + (result.stderr || '');
}
async function until(check, description, timeout = 15_000) {
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) {
		const value = await check();
		if (value) return value;
		await delay(25);
	}
	throw new Error('Timed out waiting for ' + description);
}

async function exercise({ label, workMs, drainMs, completes }) {
	const name = 'realtime-lifecycle-' + randomUUID();
	containers.add(name);
	let socket;
	try {
		docker('run', '--detach', '--name', name,
			'--publish', '127.0.0.1::3000',
			'--mount', 'type=bind,source=' + path.join(fixture, 'build') + ',target=/app/build,readonly',
			'--mount', 'type=bind,source=' + path.join(fixture, 'node_modules') + ',target=/app/node_modules,readonly',
			'--env', 'HOST=0.0.0.0', '--env', 'PORT=3000', '--env', 'SHUTDOWN_TIMEOUT=2',
			'--env', 'REALTIME_LIFECYCLE_TEST=1', '--env', 'REALTIME_LIFECYCLE_DRAIN_MS=' + drainMs,
			image, 'node', '/app/build/index.js');
		const port = Number(docker('port', name, '3000/tcp').match(/:(\d+)$/)?.[1]);
		assert(Number.isInteger(port) && port > 0, 'Docker assigned a private HTTP port');
		await until(() => {
			const output = logs(name);
			if (docker('inspect', '--format', '{{.State.Running}}', name) !== 'true') throw new Error('Production server exited during startup:\n' + output);
			return output.includes('lifecycle:init');
		}, 'the built realtime init hook');
		socket = new WebSocket('ws://127.0.0.1:' + port + '/ws', { handshakeTimeout: 5000 });
		const frames = [];
		let closed;
		socket.on('message', data => {
			const frame = JSON.parse(data.toString());
			if (frame.topic === '__rpc') frames.push({ id: frame.event, ...frame.data });
		});
		socket.on('close', (code, reason) => { closed = { code, reason: reason.toString() }; });
		await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
		socket.send(JSON.stringify({ rpc: 'lifecycle/wait', id: 'held', args: [workMs] }));
		await until(() => logs(name).includes('lifecycle:work-started'), 'tracked RPC entry');
		const start = performance.now();
		// Docker delivers an actual Linux SIGTERM to the Node server process.
		docker('kill', '--signal=SIGTERM', name);
		await until(() => logs(name).includes('Received SIGTERM'), 'the adapter signal handler');
		socket.send(JSON.stringify({ rpc: 'echo/echo', id: 'after-signal', args: ['new work'] }));
		const refused = await until(() => frames.find(frame => frame.id === 'after-signal'), 'admission refusal');
		assert.equal(refused.code, 'UNAVAILABLE', 'new RPC work is rejected while the existing call drains');
		await until(() => docker('inspect', '--format', '{{.State.Running}}', name) === 'false', 'clean server exit', drainMs + 5000);
		const elapsed = performance.now() - start;
		assert.equal(docker('inspect', '--format', '{{.State.ExitCode}}', name), '0');
		await until(() => closed, 'WebSocket close');
		assert.equal(closed.code, 1001, 'the adapter flushes a graceful close frame');
		const output = logs(name);
		assert(output.includes('lifecycle:teardown'), 'the built realtime shutdown hook runs teardown');
		assert(output.includes('Shutdown complete'), 'adapter shutdown finishes');
		if (completes) {
			assert(output.indexOf('lifecycle:work-completed') < output.indexOf('lifecycle:teardown'), 'tracked work completes before teardown');
			assert.equal(frames.find(frame => frame.id === 'held')?.data, 'finished', 'the original RPC response is flushed');
		} else {
			assert(!output.includes('lifecycle:work-completed'), 'unfinished work is bounded by the drain budget');
			assert(elapsed >= drainMs * 0.75 && elapsed < drainMs + 4000, 'shutdown waits for the budget and then exits');
			assert(!frames.some(frame => frame.id === 'held'), 'unfinished work has no fabricated success');
		}
		console.log('Packed production lifecycle ' + label + ' passed (' + Math.round(elapsed) + 'ms after SIGTERM).');
	} catch (error) {
		console.error(logs(name));
		throw error;
	} finally {
		if (socket) socket.terminate();
		removeContainer(name);
	}
}

try {
	docker('info');
	try { docker('image', 'inspect', image); }
	catch { execFileSync('docker', ['pull', image], { stdio: 'inherit', timeout: 180_000 }); }
	const packed = JSON.parse(execFileSync(process.execPath, [npm, 'pack', '--json', '--pack-destination', temporary], {
		cwd: repository, encoding: 'utf8', timeout: 120_000
	}))[0];
	cpSync(sourceFixture, fixture, { recursive: true, filter: source => !['node_modules', 'build', '.svelte-kit', '.vite', '$types.d.ts'].includes(path.basename(source)) });
	const installed = path.join(fixture, 'node_modules/svelte-realtime');
	execFileSync(process.execPath, [npm, 'install', '--no-audit', '--no-fund', path.join(temporary, packed.filename)], {
		cwd: fixture, stdio: 'inherit', timeout: 120_000
	});
	assert.equal(realpathSync(installed), installed, 'the package under test is extracted, not a workspace link');
	console.log('Building packed ' + packed.filename + ' (' + packed.shasum + ').');
	execFileSync(process.execPath, [path.join(fixture, 'node_modules/vite/bin/vite.js'), 'build'], {
		cwd: fixture, stdio: 'inherit', timeout: 120_000,
		env: { ...process.env, REALTIME_CHAOS_FIXTURE: fixture }
	});
	await exercise({ label: 'completed drain', workMs: 2000, drainMs: 4000, completes: true });
	await exercise({ label: 'bounded timeout', workMs: 30_000, drainMs: 800, completes: false });
} finally {
	for (const name of containers) removeContainer(name);
	// Validate the owned temporary root before recursively deleting its fixture.
	assert.equal(path.dirname(path.resolve(temporary)), path.resolve(tmpdir()));
	assert(path.basename(temporary).startsWith('realtime-production-lifecycle-'));
	rmSync(temporary, { recursive: true, force: true });
}
