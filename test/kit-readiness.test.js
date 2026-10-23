import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import { createServer as createHttpServer } from 'node:http';
import { waitForFixture } from './kit-compat/server-ready.mjs';

async function pendingChild(run) {
	const child = spawn(process.execPath, ['-e', 'process.stdin.resume()'], {
		windowsHide: true, stdio: ['pipe', 'ignore', 'ignore']
	});
	await once(child, 'spawn');
	try { await run(child); }
	finally { const exited = once(child, 'exit'); child.kill(); await exited; }
}

describe('Kit fixture readiness ownership', () => {
	it('rejects an unrelated TCP listener while the spawned child is still alive', async () => {
		const sockets = new Set();
		const server = createServer(socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
		server.listen(0, '127.0.0.1');
		await once(server, 'listening');
		try {
			await pendingChild(async child => {
				await expect(waitForFixture({ child, origin: 'http://127.0.0.1:' + server.address().port,
					token: randomUUID(), timeoutMs: 150 })).rejects.toThrow(/ready/);
				expect(child.exitCode).toBeNull();
			});
		} finally { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); }
	});
	async function identityServer(respond, port = 0) {
		const requests = [];
		const server = createHttpServer((req, res) => {
			requests.push(req.url);
			const body = respond(req);
			res.writeHead(body ? 200 : 404, { 'content-type': 'application/json' });
			res.end(JSON.stringify(body ?? {}));
		});
		server.listen(port, '127.0.0.1');
		await once(server, 'listening');
		return { origin: 'http://127.0.0.1:' + server.address().port, requests, close: () => new Promise(resolve => server.close(resolve)) };
	}
	it.each(['token', 'pid'])('rejects a foreign fixture with the wrong %s', async mismatch => {
		await pendingChild(async child => {
			const token = randomUUID();
			const server = await identityServer(() => ({
				pid: mismatch === 'pid' ? child.pid + 1 : child.pid,
				token: mismatch === 'token' ? 'another-run' : token
			}));
			try {
				await expect(waitForFixture({ child, origin: server.origin, token, timeoutMs: 150 })).rejects.toThrow(/ready/);
			} finally { await server.close(); }
		});
	});
	it('accepts the matching child and per-run fixture identity over HTTP', async () => {
		await pendingChild(async child => {
			const token = randomUUID();
			const server = await identityServer(req => req.url === '/readiness' ? { pid: child.pid, token } : null);
			try {
				await waitForFixture({ child, origin: server.origin, token, timeoutMs: 1000 });
				expect(server.requests).toEqual(['/readiness']);
			} finally { await server.close(); }
		});
	});
	it('keeps waiting through a refused port and a listener that closes, until the fixture binds', async () => {
		// Vite 8 listens on the port for a moment to check that it is free, then
		// initializes before it binds for real.
		await pendingChild(async child => {
			const token = randomUUID();
			const probe = createServer(socket => socket.destroy());
			probe.listen(0, '127.0.0.1');
			await once(probe, 'listening');
			const port = probe.address().port;
			await new Promise(resolve => probe.close(resolve));
			const waiting = waitForFixture({ child, origin: 'http://127.0.0.1:' + port, token, timeoutMs: 10000 });
			await new Promise(resolve => setTimeout(resolve, 200));
			const check = createServer(socket => socket.destroy());
			check.listen(port, '127.0.0.1');
			await once(check, 'listening');
			await new Promise(resolve => setTimeout(resolve, 200));
			await new Promise(resolve => check.close(resolve));
			const server = await identityServer(req => req.url === '/readiness' ? { pid: child.pid, token } : null, port);
			try {
				await waiting;
				expect(server.requests.at(-1)).toBe('/readiness');
			} finally { await server.close(); }
		});
	});
	it('stops waiting when the spawned child exits', async () => {
		const child = spawn(process.execPath, ['-e', ''], { windowsHide: true, stdio: 'ignore' });
		await once(child, 'exit');
		await expect(waitForFixture({ child, origin: 'http://127.0.0.1:9', token: randomUUID(), timeoutMs: 1000 })).rejects.toThrow(/exited/);
	});
});
