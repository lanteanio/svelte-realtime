import { execFileSync } from 'node:child_process';
import { cpSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createTestServer } from 'svelte-adapter-uws/testing';
import { packCommit, recordedSource } from '../scripts/verify-release-source.js';

// Rehearse the 0.5 to 0.6 required edits. The fixture is first served
// unedited by svelte-realtime 0.5.14, repacked from its recorded source commit
// and matched against the ledger's published shasum and integrity. The packed
// candidate then refuses the same module the documented way, and the edited
// module serves a real WebSocket client through the adapter.
//
// The candidate consumer borrows this repository's installed dependencies
// through directory links instead of installing from a lockfile; only
// svelte-realtime itself always comes from a tarball.
const root = fileURLToPath(new URL('..', import.meta.url));
const fixture = fileURLToPath(new URL('./fixtures/migration-0.5', import.meta.url));
const manifest = readFileSync(join(root, 'docs/release-manifest.md'), 'utf8');
const links = [];
let temp, stable, candidate, server;

function install(consumer, tarball) {
	cpSync(fixture, consumer, { recursive: true });
	writeFileSync(join(consumer, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
	const target = join(consumer, 'node_modules/svelte-realtime');
	mkdirSync(target, { recursive: true });
	// Relative paths: GNU tar reads a drive letter as a remote host.
	const local = (path) => relative(temp, path).split(sep).join('/');
	execFileSync('tar', ['-xzf', local(tarball), '-C', local(target), '--strip-components=1'], { cwd: temp, timeout: 120000 });
}

// Remove every directory link before the recursive delete, so the delete can
// never follow one into the repository's real node_modules.
function removeTemp() {
	for (const link of links.splice(0)) {
		try { unlinkSync(link); } catch { rmdirSync(link); }
	}
	if (!temp) return;
	for (const consumer of [stable, candidate]) {
		const modules = consumer && join(consumer, 'node_modules');
		let entries = [];
		try { entries = readdirSync(modules); } catch { continue; }
		for (const entry of entries) {
			if (lstatSync(join(modules, entry)).isSymbolicLink()) throw new Error('refusing to delete through a remaining link: ' + join(modules, entry));
		}
	}
	rmSync(temp, { recursive: true, force: true });
}

beforeAll(() => {
	temp = mkdtempSync(join(tmpdir(), 'realtime-migration-'));
	const tarballs = join(temp, 'tarballs');
	mkdirSync(tarballs);

	const recorded = recordedSource(manifest, '0.5.14');
	const released = packCommit(root, recorded.head, tarballs);
	expect({ version: released.version, shasum: released.shasum, integrity: released.integrity })
		.toEqual({ version: '0.5.14', shasum: recorded.shasum, integrity: recorded.integrity });
	stable = join(temp, 'stable');
	install(stable, released.filename);

	const npm = process.env.npm_execpath || join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
	const [packed] = JSON.parse(execFileSync(process.execPath, [npm, 'pack', '--json', '--ignore-scripts', '--pack-destination', tarballs], { cwd: root, encoding: 'utf8', timeout: 120000 }));
	candidate = join(temp, 'candidate');
	install(candidate, join(tarballs, packed.filename));
	for (const entry of readdirSync(join(root, 'node_modules'))) {
		if (entry.startsWith('.') || entry === 'svelte-realtime') continue;
		const link = join(candidate, 'node_modules', entry);
		symlinkSync(join(root, 'node_modules', entry), link, 'junction');
		links.push(link);
	}
}, 240000);
afterAll(async () => {
	try {
		await server?.close();
	} finally {
		removeTemp();
	}
});

function edit(file, from, to) {
	const path = join(candidate, file);
	const source = readFileSync(path, 'utf8');
	if (!source.includes(from)) throw new Error('0.5 fixture drifted: ' + from);
	writeFileSync(path, source.replace(from, to));
}

it('serves the unedited module on the recorded 0.5.14 artifact', async () => {
	const module = await import(pathToFileURL(join(stable, 'live.js')).href);
	const { createTestEnv } = await import(pathToFileURL(join(stable, 'node_modules/svelte-realtime/test.js')).href);
	const env = createTestEnv();
	try {
		const client = env.connect({ id: 'user-1' });
		expect(Object.keys(module.board.__actions)).toEqual(['presence']);
		await expect(client.call('board/board/__action/presence', 'b1', 'away')).resolves.toEqual({ boardId: 'b1', status: 'away', by: 'user-1' });
		await expect(client.call('account/whoami')).resolves.toEqual({ id: 'user-1' });
		// 0.5 answers an unregistered path with an explicit not-found reply.
		await expect(client.call('account/missing')).rejects.toMatchObject({ code: 'NOT_FOUND' });
	} finally {
		env.cleanup();
	}
}, 60000);

it('applies the documented edits and serves the migrated module through the packed candidate', async () => {
	const module = join(candidate, 'live.js');
	await expect(import(pathToFileURL(module).href + '?baseline')).rejects.toThrow("action 'presence' has the name of a member");

	// Required edit: rename the action that collides with a generated member.
	edit('live.js', 'presence: async (ctx, boardId, status)', 'setStatus: async (ctx, boardId, status)');
	const migrated = await import(pathToFileURL(module).href + '?migrated');
	expect(Object.keys(migrated.board.__actions)).toEqual(['setStatus']);

	server = await createTestServer({ handler: { ...migrated.handler, upgrade: () => ({ id: 'user-1' }) } });
	let socket;
	try {
		socket = new WebSocket(server.wsUrl);
		const frames = [];
		socket.addEventListener('message', ({ data }) => { if (typeof data === 'string') frames.push(JSON.parse(data)); });
		await new Promise((resolve, reject) => {
			socket.addEventListener('open', resolve, { once: true });
			socket.addEventListener('error', reject, { once: true });
		});
		let sequence = 0;
		async function call(path, args) {
			const id = 'call-' + ++sequence;
			socket.send(JSON.stringify({ rpc: path, id, args }));
			const deadline = Date.now() + 5000;
			let reply;
			while (!(reply = frames.find(f => f.topic === '__rpc' && f.event === id)?.data) && Date.now() < deadline) await new Promise(r => setTimeout(r, 10));
			return reply;
		}
		expect(await call('board/board/__action/setStatus', ['b1', 'away'])).toMatchObject({ ok: true, data: { boardId: 'b1', status: 'away', by: 'user-1' } });
		expect(await call('account/whoami', [])).toMatchObject({ ok: true, data: { id: 'user-1' } });
		// Changed default: an unregistered path answers like a denied caller.
		expect(await call('account/missing', [])).toMatchObject({ ok: false, code: 'FORBIDDEN' });
	} finally {
		socket?.close();
		const running = server;
		server = undefined;
		await running.close();
	}
}, 180000);
