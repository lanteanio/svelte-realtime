import { expect, it } from 'vitest';
import { build } from 'vite';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createTestServer } from 'svelte-adapter-uws/testing';

it('delivers JSON snapshots through the installed adapter and rejects invalid arguments before the peer receives them', async () => {
	const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
	const scratch = await mkdtemp(join(tmpdir(), 'realtime-rpc-wire-'));
	const entry = join(scratch, 'entry.js');
	const rpcPath = JSON.stringify(join(root, 'src/client/rpc.js').replaceAll('\\', '/'));
	const statePath = JSON.stringify(join(root, 'src/client/internal-state.js').replaceAll('\\', '/'));
	const adapterPath = JSON.stringify(join(root, 'node_modules/svelte-adapter-uws/src/client.js').replaceAll('\\', '/'));
	let server, conn;
	try {
		await writeFile(entry, 'export { __rpc, __binaryRpc, batch } from ' + rpcPath + '; export { clientState, pending, _offlineQueue, RpcError } from ' + statePath + '; export { connect, ready } from ' + adapterPath + ';');
		await build({ configFile: false, logLevel: 'error', define: { 'process.env.NODE_ENV': '"production"' },
			build: { lib: { entry, formats: ['es'], fileName: () => 'client.mjs' }, outDir: scratch, emptyOutDir: false, minify: true }
		});
		const frames = [];
		const decoder = new TextDecoder();
		server = await createTestServer({ handler: {
			message(ws, ctx) {
				const message = ctx.msg ?? JSON.parse(decoder.decode(ctx.data));
				if (!message || message.type === 'hello') return;
				frames.push(message);
				ws.send(JSON.stringify({ topic: '__rpc', event: message.id, data: { ok: true, data: message } }));
			}
		} });
		const api = await import(pathToFileURL(join(scratch, 'client.mjs')).href);
		conn = api.connect({ url: server.wsUrl });
		api.clientState.config.timeout = 2000;
		const rpc = api.__rpc('items/"save');
		const value = { count: 1 };
		const parked = rpc(value);
		value.count = 2;
		await api.ready();
		expect((await parked).args).toEqual([{ count: 1 }]);
		let snapshots = 0;
		const reply = await rpc.with({ idempotencyKey: 'key"\\\n' })({ toJSON() { snapshots++; return { text: 'Grüße' }; } });
		expect(snapshots).toBe(1);
		expect(reply).toMatchObject({ rpc: 'items/"save', idempotencyKey: 'key"\\\n', args: [{ text: 'Grüße' }] });
		const cycle = {}; cycle.self = cycle;
		for (const call of [() => rpc({ value: 1n }), () => rpc.fresh(cycle), () => rpc.with({ timeout: 20 })({ toJSON() { throw new TypeError('cannot encode'); } }), () => api.__binaryRpc('items/binary')(new ArrayBuffer(1), cycle)]) {
			const result = call();
			expect(result).toBeInstanceOf(Promise);
			const error = await result.catch(error => error);
			expect(error).toBeInstanceOf(api.RpcError);
			expect(error.code).toBe('INVALID_REQUEST');
			expect(error.cause).toBeInstanceOf(TypeError);
		}
		await expect(api.batch(() => [rpc('valid'), rpc(cycle)])).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
		api.clientState.isOffline = true;
		api.clientState.config.offline = { queue: true };
		await expect(rpc(cycle)).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
		expect(api._offlineQueue).toHaveLength(0);
		expect(api.pending.size).toBe(0);
		expect(frames).toHaveLength(2);
	} finally {
		conn?.close();
		await server?.close();
		if (dirname(resolve(scratch)) !== resolve(tmpdir()) || !basename(scratch).startsWith('realtime-rpc-wire-')) throw new Error('Unsafe temporary directory');
		await rm(scratch, { recursive: true, force: true });
	}
}, 20000);
