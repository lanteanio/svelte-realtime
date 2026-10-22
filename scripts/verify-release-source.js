// Repack a recorded release from repository bytes and compare it with the ledger.
import { isScriptEntry } from './script-entry.js';
import { parseManifest } from './check-release-ledger.js';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The source commit the ledger names for a version: its Git head, or its source reconstruction. */
export function recordedSource(manifest, version) {
	const tables = parseManifest(manifest);
	const row = tables['Published releases'].find((values) => values[1] === version);
	if (!row) throw new Error(`No published row for ${version}`);
	const reconstruction = tables['Source reconstructions'].find((values) => values[1] === version);
	const head = row[3] === 'legacy-unrecorded' ? reconstruction?.[2] : row[3];
	return { head, integrity: row[5], shasum: row[6] };
}

function npm(args, cwd) {
	const options = { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000 };
	const cli = process.env.npm_execpath;
	if (cli && /\.c?js$/.test(cli)) return execFileSync(process.execPath, [cli, ...args], options);
	// npm is a batch file on Windows; the arguments are fixed literals.
	if (process.platform === 'win32') return execFileSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'npm', ...args], options);
	return execFileSync('npm', args, options);
}

/**
 * Check out `head` exactly as committed (no line-ending conversion), run
 * `npm pack --dry-run` there and return the tarball's shasum and integrity.
 * Uses a private index, so the repository's index and working tree stay untouched.
 */
export function packCommit(directory, head) {
	const scratch = mkdtempSync(join(tmpdir(), 'realtime-source-'));
	try {
		const git = (...args) => execFileSync('git', ['-c', 'core.autocrlf=false', '-c', 'core.eol=lf', ...args], {
			cwd: directory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000,
			env: { ...process.env, GIT_INDEX_FILE: join(scratch, 'index') }
		}).trim();
		const commit = git('rev-parse', '--verify', '--end-of-options', `${head}^{commit}`);
		git('read-tree', commit);
		git('checkout-index', '--all', '--force', `--prefix=${join(scratch, 'package')}/`);
		const [packed] = JSON.parse(npm(['pack', '--dry-run', '--json', '--ignore-scripts'], join(scratch, 'package')));
		return { commit, shasum: packed.shasum, integrity: packed.integrity, version: packed.version };
	} finally {
		rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	}
}

export function verifyReleaseSource(directory, manifest, version, head) {
	const recorded = recordedSource(manifest, version);
	if (!(head ?? recorded.head)) throw new Error(`No recorded source commit for ${version}; pass --head <commit> to test one`);
	const packed = packCommit(directory, head ?? recorded.head);
	const errors = [];
	if (packed.version !== version) errors.push(`${packed.commit} packs version ${packed.version}, not ${version}`);
	if (packed.shasum !== recorded.shasum) errors.push(`${packed.commit} packs shasum ${packed.shasum}; the ledger records ${recorded.shasum}`);
	if (packed.integrity !== recorded.integrity) errors.push(`${packed.commit} packs integrity ${packed.integrity}; the ledger records ${recorded.integrity}`);
	return { ...packed, errors };
}

function main() {
	const args = process.argv.slice(2);
	const valid = (args.length === 1 || (args.length === 3 && args[1] === '--head')) && args.every(Boolean);
	if (!valid) throw new Error('Usage: verify-release-source.js <version> [--head <commit>]');
	const manifest = readFileSync(resolve(root, 'docs/release-manifest.md'), 'utf8');
	const result = verifyReleaseSource(root, manifest, args[0], args[2]);
	if (result.errors.length) throw new Error(result.errors.join('\n'));
	console.log(`svelte-realtime@${args[0]}: ${result.commit} packs to the recorded shasum ${result.shasum} and integrity`);
}
if (isScriptEntry(import.meta.url)) {
	try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
