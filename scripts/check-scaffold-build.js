import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderViteConfig, runScaffoldVerification } from '../src/cli-utils.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const defaultFixture = join(root, 'test', 'fixture');
const vite = join(root, 'node_modules', 'vite', 'bin', 'vite.js');

function installedPreflight(fixture) {
	const require = createRequire(join(fixture, 'package.json'));
	let directory = dirname(require.resolve('svelte-adapter-uws'));
	while (true) {
		const manifest = join(directory, 'package.json');
		if (existsSync(manifest)) {
			const pkg = JSON.parse(readFileSync(manifest, 'utf8'));
			if (pkg.name === 'svelte-adapter-uws') {
				const bin = pkg.bin?.['svelte-adapter-uws-preflight'];
				if (typeof bin !== 'string') throw new Error('The installed adapter has no native preflight command.');
				return resolve(directory, bin);
			}
		}
		const parent = dirname(directory);
		if (parent === directory) throw new Error('Could not locate the installed adapter package.');
		directory = parent;
	}
}

export function checkScaffoldBuild({ fixture = defaultFixture, run = spawnSync, log = console.log } = {}) {
	fixture = resolve(fixture);
	const config = join(fixture, '.scaffold-build-' + process.pid + '.mjs');
	const output = join(fixture, 'build');
	const entry = join(output, 'index.js');
	const preflight = installedPreflight(fixture);
	const execute = (args, showOutput = false) => {
		const result = run(process.execPath, args, {
			cwd: fixture, encoding: 'utf8', env: { ...process.env, NODE_ENV: 'production' }
		});
		if (showOutput || result.status !== 0) {
			if (result.stdout) log(result.stdout.trimEnd());
			if (result.stderr) log(result.stderr.trimEnd());
		}
		if (result.error) throw result.error;
		if (result.status !== 0) throw new Error('Scaffold verification command failed: ' + args[0] + ' (exit ' + result.status + ')');
	};
	try {
		runScaffoldVerification({
			agent: 'npm', dest: fixture, bin: name => name, onStep: log, onSuccess: log,
			run(_file, args) {
				if (args[0] === 'exec') {
					// Use the project's installed bin directly, including its native
					// load probe; no package-manager fallback can download another one.
					execute([preflight], true);
					return;
				}
				if (args.join(' ') !== 'run build') throw new Error('Unexpected scaffold verification command.');
				if (dirname(output) !== fixture) throw new Error('refusing to clean an unexpected build path');
				rmSync(output, { recursive: true, force: true });
				const startedAt = Date.now();
				writeFileSync(config, renderViteConfig());
				execute([vite, 'build', '--config', config]);
				if (!existsSync(entry) || statSync(entry).mtimeMs < startedAt - 1000) {
					throw new Error('Generated config produced no fresh build/index.js');
				}
			}
		});
	} finally {
		rmSync(config, { force: true });
	}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try { checkScaffoldBuild(); }
	catch (error) {
		console.error('check-scaffold-build FAILED:', error.message);
		process.exitCode = 1;
	}
}
