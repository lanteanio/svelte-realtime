import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	isPidAlive,
	retryPortBind,
	terminateChild,
	terminateOwnedProcess
} from './chaos/process-lifecycle.js';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const recoverySource = readFileSync(path.join(testDir, 'chaos/recovery.spec.js'), 'utf-8');

function pickPort() {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.unref();
		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => {
			const port = /** @type {any} */ (server.address()).port;
			server.close(() => resolve(port));
		});
	});
}

async function spawnOwnedProcess() {
	const cleanupPort = /** @type {number} */ (await pickPort());
	const cleanupToken = randomUUID();
	const source = [
		"const { createServer } = require('node:http');",
		'const port = Number(process.argv[1]);',
		'const token = process.argv[2];',
		'const server = createServer((request, response) => {',
		"  if (request.method !== 'POST' || request.url !== '/__chaos__/shutdown') { response.writeHead(404).end(); return; }",
		"  if (request.headers['x-chaos-cleanup-token'] !== token) { response.writeHead(403).end(); return; }",
		"  response.writeHead(202).end('shutting down');",
		'  setTimeout(() => process.exit(0), 25).unref();',
		'});',
		"server.listen(port, '127.0.0.1', () => process.stdout.write('READY\\n'));"
	].join('\n');
	const child = spawn(process.execPath, ['-e', source, String(cleanupPort), cleanupToken], {
		stdio: ['ignore', 'pipe', 'pipe']
	});
	await new Promise((resolve, reject) => {
		let output = '';
		const timer = setTimeout(() => reject(new Error('owned fixture did not become ready: ' + output)), 5_000);
		child.stdout.on('data', (chunk) => {
			output += chunk.toString();
			if (output.includes('READY')) {
				clearTimeout(timer);
				resolve();
			}
		});
		child.stderr.on('data', (chunk) => { output += chunk.toString(); });
		child.once('exit', (code) => {
			clearTimeout(timer);
			reject(new Error('owned fixture exited before readiness with code ' + code + ': ' + output));
		});
	});
	return { child, cleanupPort, cleanupToken };
}

describe('chaos lifecycle', () => {
	it('retries recognized host-port collisions and then succeeds', async () => {
		let attempts = 0;
		let cleanups = 0;
		const collision = Object.assign(new Error('docker compose up failed'), {
			stderr: Buffer.from('Bind for 0.0.0.0:49152 failed: port is already allocated')
		});
		const result = await retryPortBind(async () => {
			attempts++;
			if (attempts < 3) throw collision;
			return 49152;
		}, async () => { cleanups++; }, { maxAttempts: 5, retryDelayMs: 0 });
		expect(result).toBe(49152);
		expect(attempts).toBe(3);
		expect(cleanups).toBe(2);
	});

	it('cleans once and immediately preserves a non-bind failure', async () => {
		let attempts = 0;
		let cleanups = 0;
		const configurationError = new Error('invalid compose interpolation');
		let caught = null;
		try {
			await retryPortBind(async () => {
				attempts++;
				throw configurationError;
			}, async () => { cleanups++; }, { maxAttempts: 5, retryDelayMs: 0 });
		} catch (error) {
			caught = error;
		}
		expect(caught).toBe(configurationError);
		expect(attempts).toBe(1);
		expect(cleanups).toBe(1);
	});

	it('never signals a live PID unless its cleanup token proves ownership', async () => {
		const owned = await spawnOwnedProcess();
		try {
			await expect(terminateOwnedProcess({
				pid: owned.child.pid,
				cleanupPort: owned.cleanupPort,
				cleanupToken: 'not-the-owner'
			})).rejects.toThrow(/refusing to signal process/);
			expect(isPidAlive(owned.child.pid)).toBe(true);

			await terminateOwnedProcess({
				pid: owned.child.pid,
				cleanupPort: owned.cleanupPort,
				cleanupToken: owned.cleanupToken
			});
			expect(isPidAlive(owned.child.pid)).toBe(false);
		} finally {
			await terminateChild(owned.child);
		}
	}, 10_000);

	it('keeps the recovery fault step free of raw PID signaling', () => {
		expect(recoverySource).not.toContain('process.kill(');
		expect(recoverySource).not.toContain('pidB');
		expect(recoverySource).toContain('terminateOwnedProcess(owned)');
	});
});
