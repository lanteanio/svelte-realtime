// Global setup for the tier-4 docker-compose chaos suite.
//
// 1. Starts a one-container Redis service via docker compose. The host
//    port is OS-assigned (docker-compose.yml maps "0:6379") so we never
//    collide with productive Redis instances on this machine.
// 2. Discovers the assigned host port via `docker compose port redis 6379`.
// 3. Builds the fixture once (vite build).
// 4. Spawns two svelte-realtime instances on OS-assigned host ports, both
//    connected to the same Redis URL. Each instance loads
//    `test/fixture/src/hooks.ws.js`, which wires the extensions pubsub
//    bus when REDIS_URL is set so publishes fan out across instances.
// 5. Stashes the per-instance ports + the redis port on globalThis so
//    the spec and global-teardown can read them.

import { execSync, spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixtureDir = path.resolve(__dirname, '../fixture');
const composeDir = __dirname;
const ctxFile = path.join(__dirname, '.chaos-ctx.json');

function pickPort() {
	return new Promise((resolve, reject) => {
		const srv = createServer();
		srv.unref();
		srv.on('error', reject);
		srv.listen(0, '127.0.0.1', () => {
			const port = /** @type {any} */ (srv.address()).port;
			srv.close(() => resolve(port));
		});
	});
}

function compose(args, opts = {}) {
	return execSync('docker compose ' + args, {
		cwd: composeDir,
		stdio: opts.stdio || 'pipe',
		encoding: 'utf-8'
	});
}

function startInstance(port, redisUrl, label) {
	return new Promise((resolve, reject) => {
		const proc = spawn('node', [
			path.resolve(__dirname, 'instance-server.js'),
			String(port),
			redisUrl,
			label
		], {
			cwd: fixtureDir,
			stdio: ['pipe', 'pipe', 'pipe'],
			env: { ...process.env }
		});

		let output = '';
		let resolved = false;

		const timeout = setTimeout(() => {
			if (!resolved) {
				resolved = true;
				proc.kill();
				reject(new Error('chaos/' + label + ' did not start within 60s\noutput: ' + output));
			}
		}, 60_000);

		function check() {
			if (!resolved && (output.includes('Listening on') || output.includes('localhost:'))) {
				resolved = true;
				clearTimeout(timeout);
				resolve(proc);
			}
		}

		proc.stdout.on('data', (chunk) => { output += chunk.toString(); check(); });
		proc.stderr.on('data', (chunk) => { output += chunk.toString(); check(); });
		proc.on('error', (err) => { if (!resolved) { resolved = true; clearTimeout(timeout); reject(err); } });
		proc.on('exit', (code) => {
			if (!resolved) {
				resolved = true;
				clearTimeout(timeout);
				reject(new Error('chaos/' + label + ' exited with code ' + code + '\noutput: ' + output));
			}
		});
	});
}

export default async function globalSetup() {
	// Start Redis. Idempotent: if a previous failed run left containers
	// behind, `down` cleans them up first.
	compose('down -v --remove-orphans');
	compose('up -d --wait');

	// Discover the OS-assigned host port for Redis.
	const portLine = compose('port redis 6379').trim();
	const m = portLine.match(/:(\d+)$/);
	if (!m) throw new Error('chaos: could not parse Redis host port from `' + portLine + '`');
	const redisPort = Number(m[1]);
	const redisUrl = 'redis://127.0.0.1:' + redisPort;

	// Force a clean fixture rebuild so latest source changes are picked up
	// (the existing prod e2e harness builds eagerly; the chaos harness mirrors).
	const buildDir = path.join(fixtureDir, 'build');
	if (existsSync(buildDir)) rmSync(buildDir, { recursive: true, force: true });
	execSync('npx vite build', { cwd: fixtureDir, stdio: 'inherit' });

	const portA = await pickPort();
	const portB = await pickPort();

	const instA = await startInstance(portA, redisUrl, 'A');
	const instB = await startInstance(portB, redisUrl, 'B');

	writeFileSync(ctxFile, JSON.stringify({ redisPort, redisUrl, portA, portB }));
	globalThis.__chaosCtx = { redisPort, redisUrl, portA, portB, instances: [instA, instB] };
}
