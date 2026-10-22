#!/usr/bin/env node
// Prove every committed package-lock.json installs with the npm ci flags CI uses.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { isScriptEntry } from './script-entry.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * npm ci flags per committed lockfile directory. A lock written in one install
 * mode is rejected by npm ci in the other (a file: dependency is a link without
 * --install-links and a packed copy with it), so the mode is part of the lock.
 */
export const installModes = {
	'.': [],
	'test/fixture': [],
	'test/fixtures/svelte4': ['--install-links']
};

export function committedLocks(directory = root) {
	return execFileSync('git', ['ls-files', '-z'], { cwd: directory, encoding: 'utf8', windowsHide: true })
		.split('\0').filter((path) => /(?:^|\/)package-lock\.json$/.test(path))
		.map((path) => posix.dirname(path)).sort();
}

export function readWorkflows(directory = root) {
	const folder = join(directory, '.github', 'workflows');
	if (!existsSync(folder)) return {};
	return Object.fromEntries(readdirSync(folder).filter((name) => /\.ya?ml$/.test(name)).sort()
		.map((name) => [name, parse(readFileSync(join(folder, name), 'utf8'))]));
}

/** Every `npm ci` a workflow runs, with the directory it installs and its flags. */
export function workflowInstalls(workflows) {
	const installs = [];
	for (const [file, workflow] of Object.entries(workflows)) {
		for (const [job, config] of Object.entries(workflow?.jobs || {})) {
			for (const step of config.steps || []) {
				if (typeof step.run !== 'string') continue;
				const cwd = step['working-directory'] ?? config.defaults?.run?.['working-directory'] ?? workflow.defaults?.run?.['working-directory'] ?? '.';
				for (const line of step.run.split(/\s*&&\s*|\r?\n/).map((part) => part.trim())) {
					const words = line.split(/\s+/);
					if (words[0] !== 'npm' || words[1] !== 'ci') continue;
					let dir = cwd;
					const flags = [];
					for (let i = 2; i < words.length; i++) {
						if (words[i] === '--prefix') dir = posix.join(cwd, words[++i] ?? '');
						else if (words[i].startsWith('--prefix=')) dir = posix.join(cwd, words[i].slice('--prefix='.length));
						else flags.push(words[i]);
					}
					installs.push({ workflow: file, job, dir: posix.normalize(dir).replace(/\/$/, '') || '.', flags: flags.sort() });
				}
			}
		}
	}
	return installs;
}

/** Every committed lock has a registered install mode, and CI installs each one in that mode. */
export function validateInstallModes(locks, installs, modes = installModes) {
	const problems = [];
	for (const dir of locks) {
		if (!Object.hasOwn(modes, dir)) problems.push(posix.join(dir, 'package-lock.json') + ' has no install mode in scripts/check-lockfiles.js');
	}
	for (const dir of Object.keys(modes)) {
		if (!locks.includes(dir)) problems.push(posix.join(dir, 'package-lock.json') + ' is registered in scripts/check-lockfiles.js but not committed');
	}
	for (const { workflow, job, dir, flags } of installs) {
		if (!Object.hasOwn(modes, dir)) problems.push(workflow + ' job ' + job + ' runs npm ci in ' + dir + ', which has no committed lock');
		else if (flags.join(' ') !== [...modes[dir]].sort().join(' ')) {
			problems.push(workflow + ' job ' + job + ' runs npm ci ' + flags.join(' ') + ' in ' + dir + ', but its lock is checked with npm ci ' + modes[dir].join(' '));
		}
	}
	if (problems.length) throw new Error(problems.join('\n'));
}

export function npmCli(env = process.env) {
	if (env.npm_execpath && /npm-cli\.c?js$/.test(env.npm_execpath)) return env.npm_execpath;
	const bin = dirname(process.execPath);
	for (const candidate of [join(bin, 'node_modules', 'npm', 'bin', 'npm-cli.js'), join(bin, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')]) {
		if (existsSync(candidate)) return candidate;
	}
	throw new Error('Could not locate npm; run this check with npm run check.');
}

/**
 * Run npm's own lockfile validation without touching node_modules. --offline
 * keeps it deterministic: a lock that needs the registry to resolve is
 * incomplete, which is the same failure.
 */
export function checkLockSync(directory, flags = [], { npm = npmCli(), run = spawnSync, label = directory } = {}) {
	const args = [npm, 'ci', '--dry-run', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--prefix', directory, ...flags];
	const result = run(process.execPath, args, { cwd: directory, encoding: 'utf8', windowsHide: true, env: process.env });
	if (result.error) throw result.error;
	if (result.status !== 0) {
		const output = (result.stderr || '') + (result.stdout || '');
		const reasons = output.split(/\r?\n/).filter((line) => /\b(?:Missing|Invalid)\b|from lock file|request to \S+ failed/.test(line))
			.map((line) => '  ' + line.replace(/^npm (?:error|ERR!) /, '').replace(/^request to (\S+) failed.*$/, 'not in the lock, so npm needed the registry: $1'));
		throw new Error(posix.join(label.replace(/\\/g, '/'), 'package-lock.json') + ' is out of sync with its package.json under ' + ['npm ci', ...flags].join(' ') + ':\n' +
			(reasons.length ? reasons.join('\n') : output.trim()) + '\n' + regenerateHint(label, flags));
	}
	checkRecordedManifests(directory, flags, label);
}

function regenerateHint(label, flags) {
	return 'Regenerate it with ' + ['npm install --package-lock-only', ...flags, '--ignore-scripts'].join(' ') +
		(label === '.' ? ' at the repository root' : ' inside ' + label.replace(/\\/g, '/')) + ' and commit the result.';
}

/**
 * npm ci accepts a lock whose recorded versions trail the manifests they came
 * from: the lock's own name and version, and the packed copy that a lock written
 * with --install-links keeps of each file: dependency (its version and
 * dependency ranges). A version bump of this checkout leaves both behind, so
 * compare them with their sources directly.
 */
function checkRecordedManifests(directory, flags, label) {
	const lockPath = join(directory, 'package-lock.json');
	if (!existsSync(lockPath)) return;
	const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
	const own = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
	const problems = [];
	for (const [where, recorded] of [['the lock', lock], ['its root package', lock.packages?.[''] ?? {}]]) {
		for (const field of ['name', 'version']) {
			if (recorded[field] !== own[field]) problems.push('  ' + where + ' records ' + field + ' ' + recorded[field] + ' but package.json has ' + own[field]);
		}
	}
	for (const [path, entry] of Object.entries(lock.packages || {})) {
		if (!path || entry.link || typeof entry.resolved !== 'string' || !entry.resolved.startsWith('file:')) continue;
		const manifestPath = join(resolve(directory, entry.resolved.slice('file:'.length)), 'package.json');
		if (!existsSync(manifestPath)) continue;
		const source = JSON.parse(readFileSync(manifestPath, 'utf8'));
		if (entry.version !== source.version) {
			problems.push('  ' + path + ' records version ' + entry.version + ' but ' + entry.resolved + ' is ' + source.version);
		}
		for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
			if (JSON.stringify(sorted(entry[field])) !== JSON.stringify(sorted(source[field]))) {
				problems.push('  ' + path + ' records stale ' + field + ' of ' + entry.resolved);
			}
		}
	}
	if (problems.length) {
		throw new Error(posix.join(label.replace(/\\/g, '/'), 'package-lock.json') + ' records stale manifest data:\n' +
			problems.join('\n') + '\n' + regenerateHint(label, flags));
	}
}

function sorted(object = {}) {
	return Object.fromEntries(Object.entries(object).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

export function checkLockfiles(directory = root, options = {}) {
	const locks = committedLocks(directory);
	validateInstallModes(locks, workflowInstalls(readWorkflows(directory)));
	const failures = [];
	for (const dir of locks) {
		try { checkLockSync(resolve(directory, dir), installModes[dir], { label: dir, ...options }); }
		catch (error) { failures.push(error.message); }
	}
	if (failures.length) throw new Error(failures.join('\n\n'));
	return locks;
}

if (isScriptEntry(import.meta.url)) {
	try { console.log('check-lockfiles: ' + checkLockfiles().map((dir) => posix.join(dir, 'package-lock.json')).join(', ') + ' match their manifests'); }
	catch (error) { console.error('check-lockfiles FAILED:\n' + error.message); process.exitCode = 1; }
}
