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

describe('Kit fixture readiness ownership', () => {
	it('rejects an unrelated TCP listener while the spawned child is still alive', async () => {
		const sockets = new Set();
		const server = createServer(socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
		server.listen(0, '127.0.0.1');
		await once(server, 'listening');
		try {
			await pendingChild(async child => {
				await expect(waitForFixture({ child, origin: 'http://127.0.0.1:' + server.address().port,
					token: randomUUID(), WebSocket, timeoutMs: 150 })).rejects.toThrow(/ready/);
				expect(child.exitCode).toBeNull();
			});
		} finally { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); }
	});
	it.each(['token', 'pid'])('rejects a foreign fixture with the wrong %s', async mismatch => {
		await pendingChild(async child => {
			const token = randomUUID();
			const server = await createTestServer({ handler: { message(socket, ctx) {
				const request = JSON.parse(Buffer.from(ctx.data).toString());
				socket.send(JSON.stringify({ topic: '__rpc', event: request.id, data: { ok: true, data: {
					pid: mismatch === 'pid' ? child.pid + 1 : child.pid,
					token: mismatch === 'token' ? 'another-run' : token
				} } }));
			} } });
			try {
				await expect(waitForFixture({ child, origin: server.url,
					token, WebSocket, timeoutMs: 150 })).rejects.toThrow(/ready/);
			} finally { await server.close(); }
		});
	});
	it('accepts the matching child and per-run fixture identity over WebSocket', async () => {
		await pendingChild(async child => {
			const token = randomUUID();
			let request;
			const server = await createTestServer({ handler: { message(socket, ctx) {
				request = JSON.parse(Buffer.from(ctx.data).toString());
				socket.send(JSON.stringify({ topic: '__rpc', event: request.id, data: { ok: true, data: { pid: child.pid, token } } }));
			} } });
			try {
				await waitForFixture({ child, origin: server.url, token, WebSocket, timeoutMs: 1000 });
				expect(request.rpc).toBe('counter/readiness');
			} finally { await server.close(); }
		});
	});
});
