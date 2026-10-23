import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import { createTestServer } from 'svelte-adapter-uws/testing';
import { waitForFixture } from './kit-compat/server-ready.mjs';

async function pendingChild(run) {
	const child = spawn(process.execPath, ['-e', 'process.stdin.resume()'], {
		windowsHide: true, stdio: ['pipe', 'ignore', 'ignore']
	});
	await once(child, 'spawn');
	try { await run(child); }
	finally { const exited = once(child, 'exit'); child.kill(); await exited; }
}

async function freePort() {
	const server = createServer();
	server.listen(0, '127.0.0.1');
	await once(server, 'listening');
	const { port } = server.address();
	await new Promise(resolve => server.close(resolve));
	return port;
}

const socketTo = url => () => new WebSocket(url.replace(/^http/, 'ws') + '/ws');
const identify = (socket, token, pid) => socket.send(JSON.stringify({ type: 'kit-compat-identity', token, pid }));

// A stand-in fixture whose open hook is onOpen(socket). Counts opened sockets.
async function withFixture(onOpen, run, options = {}) {
	const opened = [];
	const server = await createTestServer({ ...options, handler: { open(socket) { opened.push(socket); onOpen(socket); } } });
	try { await run(server.url, opened); }
	finally { await server.close(); }
}

describe('Kit fixture readiness ownership', () => {
	it('keeps waiting on a listener that accepts TCP but never opens a WebSocket', async () => {
		const sockets = new Set();
		const server = createServer(socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
		server.listen(0, '127.0.0.1');
		await once(server, 'listening');
		try {
			await pendingChild(async child => {
				await expect(waitForFixture({ child, connect: socketTo('http://127.0.0.1:' + server.address().port),
					token: randomUUID(), timeoutMs: 300 })).rejects.toThrow(/did not become ready: socket did not open/);
				expect(child.exitCode).toBeNull();
			});
		} finally { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); }
	});

	it('retries refused attempts until the server binds', async () => {
		await pendingChild(async child => {
			const token = randomUUID();
			const port = await freePort();
			const url = 'http://127.0.0.1:' + port;
			const waiting = waitForFixture({ child, connect: socketTo(url), token, timeoutMs: 10000 });
			await new Promise(resolve => setTimeout(resolve, 300));
			await withFixture(socket => identify(socket, token, child.pid), async (_url, opened) => {
				expect(await waiting).toEqual({ token, pid: child.pid });
				expect(opened).toHaveLength(1);
			}, { port });
		});
	});

	it.each(['token', 'pid'])('rejects another server with the wrong %s at once', async mismatch => {
		await pendingChild(async child => {
			const token = randomUUID();
			await withFixture(socket => identify(socket,
				mismatch === 'token' ? 'another-run' : token,
				mismatch === 'pid' ? child.pid + 1 : child.pid
			), async (url, opened) => {
				const started = Date.now();
				await expect(waitForFixture({ child, connect: socketTo(url), token, timeoutMs: 5000 }))
					.rejects.toThrow(/Another server answered on the port/);
				expect(Date.now() - started).toBeLessThan(2500);
				expect(opened).toHaveLength(1);
			});
		});
	});

	it('returns the identity of the spawned child', async () => {
		await pendingChild(async child => {
			const token = randomUUID();
			await withFixture(socket => identify(socket, token, child.pid), async (url, opened) => {
				expect(await waitForFixture({ child, connect: socketTo(url), token, timeoutMs: 1000 })).toEqual({ token, pid: child.pid });
				expect(opened).toHaveLength(1);
			});
		});
	});

	it('ignores other frames before the identity', async () => {
		await pendingChild(async child => {
			const token = randomUUID();
			await withFixture(socket => {
				socket.send(JSON.stringify({ type: 'welcome', sessionId: 'session' }));
				socket.send(JSON.stringify({ topic: 'compat:counter', event: 'set', data: { token: 'another-run', pid: 1 } }));
				socket.send('not json');
				identify(socket, token, child.pid);
			}, async url => {
				expect(await waitForFixture({ child, connect: socketTo(url), token, timeoutMs: 1000 })).toEqual({ token, pid: child.pid });
			});
		});
	});

	it('fails when a server that opened never identifies itself', async () => {
		await pendingChild(async child => {
			await withFixture(() => {}, async (url, opened) => {
				const started = Date.now();
				await expect(waitForFixture({ child, connect: socketTo(url), token: randomUUID(), timeoutMs: 5000, identityTimeoutMs: 100 }))
					.rejects.toThrow(/did not identify itself: no identity within 100 ms/);
				expect(Date.now() - started).toBeLessThan(2500);
				expect(opened).toHaveLength(1);
			});
		});
	});

	it('fails when an open socket closes before the identity', async () => {
		await pendingChild(async child => {
			await withFixture(socket => socket.end(1011, 'closing'), async (url, opened) => {
				await expect(waitForFixture({ child, connect: socketTo(url), token: randomUUID(), timeoutMs: 5000 }))
					.rejects.toThrow(/did not identify itself: socket closed \(1011\)/);
				expect(opened).toHaveLength(1);
			});
		});
	});

	it('stops waiting once the child has exited', async () => {
		const child = spawn(process.execPath, ['-e', ''], { windowsHide: true, stdio: 'ignore' });
		await once(child, 'exit');
		const started = Date.now();
		await expect(waitForFixture({ child, connect: socketTo('http://127.0.0.1:9'), token: randomUUID(), timeoutMs: 5000 }))
			.rejects.toThrow(/Server exited before becoming ready/);
		expect(Date.now() - started).toBeLessThan(1000);
	});
});
