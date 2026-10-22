import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createTestServer } from 'svelte-adapter-uws/testing';

// Rehearse the 0.5 to 0.6 required edits against the packed candidate: the
// 0.5-era module fails the documented way, the edited module boots, and a real
// WebSocket client reads its RPC result back through the adapter.
const root = fileURLToPath(new URL('..', import.meta.url));
const fixture = fileURLToPath(new URL('./fixtures/migration-0.5', import.meta.url));
let temp, consumer, server;

beforeAll(() => {
	temp = mkdtempSync(join(tmpdir(), 'realtime-migration-'));
	const npm = process.env.npm_execpath || join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
	const [packed] = JSON.parse(execFileSync(process.execPath, [npm, 'pack', '--json', '--ignore-scripts', '--pack-destination', temp], { cwd: root, encoding: 'utf8', timeout: 120000 }));
	consumer = join(temp, 'consumer');
	cpSync(fixture, consumer, { recursive: true });
	const installed = join(consumer, 'node_modules/svelte-realtime');
	mkdirSync(installed, { recursive: true });
	execFileSync('tar', ['-xzf', packed.filename, '-C', 'consumer/node_modules/svelte-realtime', '--strip-components=1'], { cwd: temp, timeout: 120000 });
	writeFileSync(join(consumer, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
	// Reuse installed dependencies; the package under test is always the tarball.
	for (const entry of readdirSync(join(root, 'node_modules'))) {
		if (entry.startsWith('.') || entry === 'svelte-realtime') continue;
		symlinkSync(join(root, 'node_modules', entry), join(consumer, 'node_modules', entry), 'junction');
	}
}, 180000);
afterAll(async () => {
	await server?.close();
	if (temp) rmSync(temp, { recursive: true, force: true });
});

function edit(file, from, to) {
	const path = join(consumer, file);
	const source = readFileSync(path, 'utf8');
	if (!source.includes(from)) throw new Error('0.5 fixture drifted: ' + from);
	writeFileSync(path, source.replace(from, to));
}

it('applies the documented edits and serves the migrated module through the packed candidate', async () => {
	const module = join(consumer, 'live.js');
	await expect(import(pathToFileURL(module).href + '?baseline')).rejects.toThrow('quota is not supported');

	// Required edit: tenant configuration keeps only validated metadata.
	edit('live.js', ", quota: { rpcPerSecond: 100 } }", ' }');
	// Changed default: erasure names its tenant when a resolver is configured.
	edit('live.js', 'return live.forget(userId);', 'return live.forget(userId, { tenantId });');
	const migrated = await import(pathToFileURL(module).href + '?migrated');
	const packedServer = await import(pathToFileURL(join(consumer, 'node_modules/svelte-realtime/src/server.js')).href);
	expect(migrated.acme.config).toEqual({ metadata: { entitlement: 'team' } });
	await expect(packedServer.live.forget('user-1')).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
	await expect(migrated.eraseUser('user-1', 'acme')).resolves.not.toThrow();

	server = await createTestServer({ handler: { ...migrated.handler, upgrade: () => ({ id: 'user-1', tenant: 'acme' }) } });
	const socket = new WebSocket(server.wsUrl);
	const frames = [];
	socket.addEventListener('message', ({ data }) => { if (typeof data === 'string') frames.push(JSON.parse(data)); });
	await new Promise((resolve, reject) => {
		socket.addEventListener('open', resolve, { once: true });
		socket.addEventListener('error', reject, { once: true });
	});
	socket.send(JSON.stringify({ rpc: 'account/whoami', id: 'who', args: [] }));
	const deadline = Date.now() + 5000;
	let reply;
	while (!(reply = frames.find(f => f.topic === '__rpc' && f.event === 'who')?.data) && Date.now() < deadline) await new Promise(r => setTimeout(r, 10));
	socket.close();
	expect(reply).toMatchObject({ ok: true, data: { id: 'user-1', plan: 'team' } });
}, 180000);
