// Global setup for the tier-4 docker-compose chaos suite.
//
// 1. Starts a one-container Redis service via docker compose. A bounded
//    reserve-and-bind retry gives stop/start one stable host port without
//    turning an ordinary bind race into a flaky recovery failure.
// 2. Verifies the bound host port via `docker compose port redis 6379`.
// 3. Builds the fixture once (vite build).
// 4. Spawns two svelte-realtime instances on OS-assigned host ports, both
//    connected to the same Redis URL. Each instance loads
//    `test/fixture/src/hooks.ws.js`, which wires the extensions pubsub
//    bus when REDIS_URL is set so publishes fan out across instances.
// 5. Stashes the per-instance ports + the redis port on globalThis so
//    the spec and global-teardown can read them.

import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { existsSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { retryPortBind, terminateChild } from './process-lifecycle.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixtureDir = path.resolve(__dirname, '../fixture');
const composeDir = __dirname;
const ctxFile = path.join(__dirname, '.chaos-ctx.json');
let redisHostPort = 0;

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

function compose(...args) {
	return execFileSync('docker', ['compose', ...args], {
		cwd: composeDir,
		stdio: 'pipe',
		encoding: 'utf-8',
		env: { ...process.env, CHAOS_REDIS_PORT: String(redisHostPort) }
	});
}

async function startRedis(maxAttempts = 5) {
	try { compose('down', '-v', '--remove-orphans'); } catch {}
	return retryPortBind(async () => {
		redisHostPort = /** @type {number} */ (await pickPort());
		compose('up', '-d', '--wait');
		const portLine = compose('port', 'redis', '6379').trim();
		const match = portLine.match(/:(\d+)$/);
		if (!match) throw new Error('could not parse Redis host port from `' + portLine + '`');
		const mappedPort = Number(match[1]);
		if (mappedPort !== redisHostPort) {
			throw new Error('reserved ' + redisHostPort + ' but Docker mapped ' + mappedPort);
		}
		return mappedPort;
	}, () => compose('down', '-v', '--remove-orphans'), { maxAttempts });
}

function startInstance(port, redisUrl, label, cleanupPort, cleanupToken, onSpawn) {
	return new Promise((resolve, reject) => {
		const proc = spawn('node', [
			path.resolve(__dirname, 'instance-server.js'),
			String(port),
			redisUrl,
			label,
			String(cleanupPort),
			cleanupToken
		], {
			cwd: fixtureDir,
			stdio: ['pipe', 'pipe', 'pipe'],
			env: { ...process.env }
		});
		onSpawn(proc);

		let output = '';
		let resolved = false;

		const timeout = setTimeout(() => {
			if (!resolved) {
				resolved = true;
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
	if (existsSync(ctxFile)) {
		throw new Error('chaos: stale context exists at ' + ctxFile + '; refusing to overwrite cleanup evidence');
	}
	const instances = [];
	let persisted = null;
	try {
		// Unlike an anonymous Docker binding, this explicit mapping survives
		// stop/start so the already-running ioredis clients reconnect in place.
		const redisPort = await startRedis();
		const redisUrl = 'redis://127.0.0.1:' + redisPort;
		persisted = {
			redisPort,
			redisUrl,
			portA: null,
			portB: null,
			ownedProcesses: []
		};
		writeFileSync(ctxFile, JSON.stringify(persisted));
		globalThis.__chaosCtx = { redisPort, redisUrl, portA: null, portB: null, instances };

		// Force a clean fixture rebuild so latest source changes are picked up.
		const buildDir = path.join(fixtureDir, 'build');
		if (existsSync(buildDir)) rmSync(buildDir, { recursive: true, force: true });
		execFileSync(process.execPath, [path.join(fixtureDir, 'node_modules/vite/bin/vite.js'), 'build'], {
			cwd: fixtureDir,
			stdio: 'inherit'
		});

		const portA = await pickPort();
		const portB = await pickPort();
		persisted.portA = portA;
		persisted.portB = portB;
		globalThis.__chaosCtx.portA = portA;
		globalThis.__chaosCtx.portB = portB;
		writeFileSync(ctxFile, JSON.stringify(persisted));

		const recordInstance = (proc, cleanupPort, cleanupToken, label) => {
			instances.push(proc);
			persisted.ownedProcesses.push({ pid: proc.pid, cleanupPort, cleanupToken, label });
			writeFileSync(ctxFile, JSON.stringify(persisted));
		};
		const cleanupPortA = await pickPort();
		const cleanupTokenA = randomUUID();
		await startInstance(portA, redisUrl, 'A', cleanupPortA, cleanupTokenA,
			(proc) => recordInstance(proc, cleanupPortA, cleanupTokenA, 'A'));
		const cleanupPortB = await pickPort();
		const cleanupTokenB = randomUUID();
		await startInstance(portB, redisUrl, 'B', cleanupPortB, cleanupTokenB,
			(proc) => recordInstance(proc, cleanupPortB, cleanupTokenB, 'B'));
	} catch (setupError) {
		const cleanupErrors = [];
		await Promise.all(instances.map((proc) => terminateChild(proc).catch((error) => cleanupErrors.push(error))));
		try {
			compose('down', '-v', '--remove-orphans');
			const remaining = compose('ps', '-q').trim();
			if (remaining) throw new Error('compose resources remain after setup rollback: ' + remaining);
		} catch (error) {
			cleanupErrors.push(error);
		}
		if (cleanupErrors.length === 0) {
			try { unlinkSync(ctxFile); } catch {}
		}
		delete globalThis.__chaosCtx;
		if (cleanupErrors.length > 0) {
			throw new AggregateError([setupError, ...cleanupErrors], 'chaos setup and rollback both failed');
		}
		throw setupError;
	}
}
