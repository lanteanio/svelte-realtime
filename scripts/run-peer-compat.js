#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, relative, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import semver from 'semver';
import { readSupport, supportMatrices, validatePeerCoverage, combinationId, targetPackages } from './check-ci-support.js';
import { isScriptEntry } from './script-entry.js';
import { resolveNpmCli } from './npm-cli.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const names = ['@sveltejs/kit', '@sveltejs/vite-plugin-svelte', 'vite', 'svelte', 'svelte-adapter-uws'];

function inRange(version, range) {
	return semver.satisfies(version, range);
}

// Select the target boundary first, then find compatible companion versions.
// Reject unsatisfiable combinations instead of forcing npm's peer resolver.
export function resolvePeerVersions(row, pkg, metadata, edge, nodeVersion, target) {
	assert.ok(['floor', 'latest'].includes(edge), 'Peer edge must be floor or latest');
	assert.ok(Object.hasOwn(targetPackages, target), 'A supported target package is required');
	const targetName = targetPackages[target];
	const order = [targetName, ...names.filter(name => name !== targetName)];
	const major = { '@sveltejs/kit': row.kit, '@sveltejs/vite-plugin-svelte': row.plugin, vite: row.vite, svelte: row.svelte, 'svelte-adapter-uws': row.adapter };
	const choices = Object.fromEntries(names.map(name => {
		const versions = Object.values(metadata[name].versions).filter(manifest =>
			semver.valid(manifest.version) &&
			(major[name] === undefined || semver.major(manifest.version) === major[name]) &&
			(pkg.peerDependencies[name] ? inRange(manifest.version, pkg.peerDependencies[name]) : !semver.prerelease(manifest.version)) &&
			(!manifest.engines?.node || inRange(nodeVersion, manifest.engines.node))
		).sort((a, b) => name === targetName && edge === 'floor' ? semver.compare(a.version, b.version) : semver.rcompare(a.version, b.version));
		assert.ok(versions.length, name + ' has no admitted version on Node ' + nodeVersion);
		return [name, versions];
	}));
	const selected = {};
	function compatible(name, manifest) {
		for (const [peer, range] of Object.entries(manifest.peerDependencies || {})) {
			if (selected[peer] && !inRange(selected[peer].version, range)) return false;
			if (choices[peer] && !selected[peer] && !choices[peer].some(candidate => inRange(candidate.version, range))) return false;
		}
		return Object.values(selected).every(other => !other.peerDependencies?.[name] || inRange(manifest.version, other.peerDependencies[name]));
	}
	function visit(index) {
		if (index === order.length) return true;
		const name = order[index];
		for (const manifest of choices[name]) {
			if (!compatible(name, manifest)) continue;
			selected[name] = manifest;
			if (visit(index + 1)) return true;
			delete selected[name];
		}
		return false;
	}
	assert.ok(visit(0), 'No compatible published peer tuple for ' + combinationId(row) + ' on Node ' + nodeVersion);
	return Object.fromEntries(names.map(name => [name, selected[name].version]));
}

async function command(argv, cwd, log) {
	const proc = spawn(argv[0], argv.slice(1), { cwd, env: process.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
	let output = '';
	for (const stream of [proc.stdout, proc.stderr]) stream.on('data', bytes => { output += bytes; process.stdout.write(bytes); });
	const [code, signal] = await once(proc, 'exit');
	await writeFile(log, output);
	assert.equal(signal, null, argv[0] + ' was terminated');
	assert.equal(code, 0, argv.join(' ') + ' failed; see ' + log);
}

async function sourceDigest(directory) {
	const hash = createHash('sha256');
	const files = (await readdir(directory, { recursive: true, withFileTypes: true })).filter(entry => entry.isFile())
		.map(entry => relative(directory, resolve(entry.parentPath, entry.name)).split(sep).join('/')).sort();
	for (const file of files) hash.update(file + '\0').update(await readFile(resolve(directory, file))).update('\0');
	return hash.digest('hex');
}

async function run() {
	const input = readSupport();
	const { table, pkg } = input;
	supportMatrices(input);
	validatePeerCoverage(input);
	const args = process.argv.slice(2);
	const option = name => args[args.indexOf(name) + 1];
	assert.ok(args.includes('--combination') && args.includes('--target') && args.includes('--edge'), '--combination, --target and --edge are required');
	const row = table.combinations.find(row => combinationId(row) === option('--combination'));
	assert.ok(row, 'Unknown peer combination');
	const edge = option('--edge');
	const target = option('--target');
	assert.ok(Object.hasOwn(targetPackages, target), 'Unknown target package');
	assert.ok(['floor', 'latest'].includes(edge), 'Peer edge must be floor or latest');
	const runId = 'peer-compat-' + combinationId(row) + '-' + target + '-' + edge + '-' + randomUUID();
	const directory = resolve(root, 'test-results', runId);
	// Vite ignores test-results when watching source files. Keep the app in
	// the fixture tree so development reloads exercise real filesystem events.
	const fixture = resolve(root, 'test', 'fixtures', runId);
	await mkdir(directory, { recursive: true });
	const reportPath = resolve(directory, 'result.json');
	const report = { status: 'failed', node: process.versions.node, combination: row, target, edge, startedAt: new Date().toISOString() };
	try {
		const metadata = Object.fromEntries(await Promise.all(names.map(async name => {
			const response = await fetch('https://registry.npmjs.org/' + encodeURIComponent(name), {
				headers: { Accept: 'application/vnd.npm.install-v1+json' }, signal: AbortSignal.timeout(30000)
			});
			assert.ok(response.ok, 'Cannot read published versions of ' + name + ': ' + response.status);
			return [name, await response.json()];
		})));
		report.versions = resolvePeerVersions(row, pkg, metadata, edge, process.versions.node, target);
		report.targetVersion = report.versions[targetPackages[target]];
		await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
		console.log(JSON.stringify(report.versions));
		const source = resolve(root, 'test', 'fixtures', row.svelte === 4 ? 'svelte4' : 'kit' + row.kit);
		await cp(source, fixture, { recursive: true, filter: path => !/(?:^|[\\/])(?:node_modules|build|\.svelte-kit|package-lock\.json)(?:[\\/]|$)/.test(path) });
		const manifest = JSON.parse(await readFile(resolve(fixture, 'package.json'), 'utf8'));
		manifest.dependencies = { ...manifest.dependencies, ...report.versions, 'svelte-realtime': 'file:' + root.replaceAll('\\', '/') };
		for (const name of names) if (manifest.devDependencies) delete manifest.devDependencies[name];
		await writeFile(resolve(fixture, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
		const npm = resolveNpmCli();
		await command([process.execPath, npm, 'install', '--install-links', '--strict-peer-deps', '--engine-strict', '--no-audit', '--no-fund'], fixture, resolve(directory, 'install.log'));
		const installed = {};
		for (const name of names) installed[name] = JSON.parse(await readFile(resolve(fixture, 'node_modules', name, 'package.json'), 'utf8')).version;
		assert.deepEqual(installed, report.versions, 'Installed peer versions differ from the requested tuple');
		report.sourceHash = await sourceDigest(resolve(root, 'src'));
		assert.equal(await sourceDigest(resolve(fixture, 'node_modules/svelte-realtime/src')), report.sourceHash, 'Installed realtime sources differ from the checkout');
		await command([process.execPath, resolve(fixture, 'node_modules/svelte-adapter-uws/scripts/preflight.js')], fixture, resolve(directory, 'native.log'));
		if (row.svelte === 4) {
			for (const step of ['build', 'check', 'stores', 'smoke']) await command([process.execPath, npm, 'run', step], fixture, resolve(directory, step + '.log'));
		} else {
			await command([process.execPath, resolve(root, 'test/kit-compat/matrix.mjs'), '--kit', String(row.kit), '--fixture', fixture, '--report-dir', directory], root, resolve(directory, 'runtime.log'));
		}
		report.status = 'passed';
	} catch (error) {
		report.error = error.stack || String(error);
		throw error;
	} finally {
		report.finishedAt = new Date().toISOString();
		await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
	}
}

if (isScriptEntry(import.meta.url)) await run();
