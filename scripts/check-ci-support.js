#!/usr/bin/env node
import assert from 'node:assert/strict';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import semver from 'semver';
import { parse } from 'yaml';
import { isScriptEntry } from './script-entry.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const load = (file) => JSON.parse(readFileSync(resolve(root, file), 'utf8'));
const date = /^\d{4}-\d{2}-\d{2}$/;
const matrixExpression = '${{ fromJSON(needs.support.outputs.node) }}';
const peersExpression = '${{ fromJSON(needs.support.outputs.peers) }}';
const peerSchedule = "${{ github.event_name == 'schedule' || github.event_name == 'workflow_dispatch' || (github.event_name == 'push' && github.ref == 'refs/heads/dev') }}";
const majorRange = major => '>=' + major + '.0.0-0 <' + (major + 1) + '.0.0-0';
const intersects = (left, right) => semver.intersects(left, right, { includePrerelease: true });
export const targetPackages = { kit: '@sveltejs/kit', svelte: 'svelte', vite: 'vite', adapter: 'svelte-adapter-uws' };

export function readSupport() {
	return {
		table: load('docs/ci-support.v1.json'),
		pkg: load('package.json'),
		kits: ['kit2', 'kit3'].map(name => load('test/fixtures/' + name + '/package-lock.json').packages['node_modules/@sveltejs/kit']),
		adapters: [load('test/fixtures/kit3/package-lock.json').packages['node_modules/svelte-adapter-uws']],
		workflow: parse(readFileSync(resolve(root, '.github/workflows/verify.yml'), 'utf8')),
		chaos: parse(readFileSync(resolve(root, '.github/workflows/chaos-recovery.yml'), 'utf8'))
	};
}

export function combinationId(row) {
	return 'kit' + row.kit + '-svelte' + row.svelte + '-vite' + row.vite + '-adapter' + row.adapter;
}

export function supportMatrices({ table, pkg }, today = new Date().toISOString().slice(0, 10)) {
	assert.equal(table.schemaVersion, 1, 'Unsupported CI support schema');
	for (const value of [today, table.checkedOn, table.checkBy]) {
		assert.ok(date.test(value) && new Date(value).toISOString().slice(0, 10) === value, 'Invalid support date');
	}
	assert.ok(table.checkedOn <= today && today <= table.checkBy, 'CI support table is outside its checked dates');
	assert.ok(table.checkedOn < table.checkBy, 'CI support table needs a future check date');
	assert.equal(new Set(table.node.lines.map(row => row.major)).size, table.node.lines.length, 'Duplicate Node major');
	for (const line of table.node.lines) {
		assert.ok(Number.isInteger(line.major) && line.major > 0, 'Invalid Node major');
		assert.ok([line.start, line.lts, line.end].every(value => date.test(value)), 'Node lines require upstream dates');
		assert.ok(line.start <= line.lts && line.lts < line.end, 'Node lifecycle dates are out of order');
	}
	const lines = table.node.lines.filter(row => row.start <= today && today < row.end && intersects(pkg.engines.node, majorRange(row.major)));
	assert.ok(lines.length, 'No maintained Node line satisfies engines.node');
	const baseline = semver.valid(table.node.baseline);
	assert.ok(baseline && semver.satisfies(baseline, pkg.engines.node), 'Pinned Node baseline must satisfy engines.node');
	assert.ok(lines.some(row => row.major === semver.major(baseline)), 'Pinned Node baseline targets an EOL or unreleased line');
	const node = { include: [{ node: baseline }, ...lines.map(row => ({ node: row.major + '.x' }))] };
	const peers = { include: lines.flatMap(line => table.combinations.flatMap(row => Object.keys(targetPackages).flatMap(target => ['floor', 'latest'].map(edge => ({ node: line.major + '.x', combination: combinationId(row), target, edge }))))) };
	return { node, peers };
}

function expectedMajors(range, recorded) {
	const maximum = Math.max(...recorded, ...new semver.Range(range).set.flatMap(set => set.map(c => c.semver.major || 0)));
	return Array.from({ length: maximum + 1 }, (_, major) => major).filter(major => intersects(range, majorRange(major)));
}

export function compatibleCombinations({ table, kits, adapters }) {
	const rows = [];
	for (const kit of kits) for (const svelte of table.peers.svelte.lines) for (const vite of table.peers.vite.lines) for (const adapter of adapters) {
		const kitMajor = semver.major(kit.version);
		const adapterMajor = semver.major(adapter.version);
		if (!intersects(kit.peerDependencies.svelte, majorRange(svelte.major)) || !intersects(kit.peerDependencies.vite, majorRange(vite.major))) continue;
		if (!intersects(adapter.peerDependencies['@sveltejs/kit'], majorRange(kitMajor)) || !intersects(adapter.peerDependencies.svelte, majorRange(svelte.major))) continue;
		if (!table.plugins.some(plugin => semver.satisfies(plugin.version, kit.peerDependencies['@sveltejs/vite-plugin-svelte']) && intersects(plugin.svelte, majorRange(svelte.major)) && intersects(plugin.vite, majorRange(vite.major)))) continue;
		rows.push({ kit: kitMajor, svelte: svelte.major, vite: vite.major, adapter: adapterMajor });
	}
	return rows;
}

export function validatePeerCoverage(input, today = new Date().toISOString().slice(0, 10)) {
	const { table, pkg, kits, adapters } = input;
	const aliases = Object.fromEntries(Object.entries(targetPackages).map(([alias, name]) => [name, alias]));
	for (const [name, range] of Object.entries(pkg.peerDependencies)) {
		const entry = table.peers[name];
		assert.ok(entry?.lines?.length, name + ' is missing from the support table');
		const actual = entry.lines.map(row => row.major).sort((a, b) => a - b);
		assert.deepEqual(actual, expectedMajors(range, actual), name + ' supported majors disagree with peerDependencies');
		assert.ok(aliases[name], name + ' needs an explicit peer matrix dimension');
		assert.deepEqual([...new Set(table.combinations.map(row => row[aliases[name]]))].sort((a, b) => a - b), actual, name + ' has no compatible CI combination');
	}
	assert.deepEqual([...new Set(adapters.map(adapter => semver.major(adapter.version)))].sort((a, b) => a - b), table.peers['svelte-adapter-uws'].lines.map(row => row.major).sort((a, b) => a - b), 'Every supported adapter major needs a fixture manifest');
	assert.deepEqual([...new Set(kits.map(kit => semver.major(kit.version)))].sort((a, b) => a - b), table.peers['@sveltejs/kit'].lines.map(row => row.major).sort((a, b) => a - b), 'Every supported Kit major needs a fixture manifest');
	const pluginMajors = table.plugins.map(plugin => semver.major(plugin.version)).sort((a, b) => a - b);
	assert.deepEqual(pluginMajors, [...new Set(kits.flatMap(kit => expectedMajors(kit.peerDependencies['@sveltejs/vite-plugin-svelte'], pluginMajors)))].sort((a, b) => a - b), 'Vite plugin majors disagree with the supported Kit peers');
	const viteMajors = table.peers.vite.lines.map(row => row.major).sort((a, b) => a - b);
	assert.deepEqual(viteMajors, [...new Set(kits.flatMap(kit => expectedMajors(kit.peerDependencies.vite, viteMajors)))].sort((a, b) => a - b), 'Vite majors disagree with the supported Kit peers');
	assert.deepEqual([...new Set(table.combinations.map(row => row.vite))].sort((a, b) => a - b), viteMajors, 'Vite has no compatible CI combination');
	assert.equal(new Set(table.combinations.map(combinationId)).size, table.combinations.length, 'Duplicate peer combination');
	assert.deepEqual(table.combinations.map(combinationId).sort(), compatibleCombinations(input).map(combinationId).sort(), 'CI combinations must cover the complete compatible peer product');
	for (const row of table.combinations) {
		for (const [name, field] of Object.entries(aliases)) assert.ok(table.peers[name].lines.some(line => line.major === row[field]), 'Unsupported ' + name + ' combination');
		assert.ok(Number.isInteger(row.plugin) && row.plugin > 0, 'A peer combination needs its compatible Vite plugin major');
		const kit = kits.find(kit => semver.major(kit.version) === row.kit);
		assert.ok(kit && intersects(kit.peerDependencies.svelte, majorRange(row.svelte)) && intersects(kit.peerDependencies.vite, majorRange(row.vite)), 'Combination is outside the Kit peer ranges');
		const plugin = table.plugins.find(plugin => semver.major(plugin.version) === row.plugin);
		assert.ok(plugin && semver.satisfies(plugin.version, kit.peerDependencies['@sveltejs/vite-plugin-svelte']) && intersects(plugin.svelte, majorRange(row.svelte)) && intersects(plugin.vite, majorRange(row.vite)), 'Combination uses an incompatible Vite plugin');
	}
	for (const [name, entry] of Object.entries(table.peers)) {
		assert.ok(entry.source?.startsWith('https://') && entry.policy, name + ' needs an upstream policy');
		for (const line of entry.lines) {
			assert.ok(line.end === null || date.test(line.end), name + ' has an invalid EOL date');
			assert.ok(line.end === null || today < line.end || line.legacy === true, name + ' targets an EOL line without an explicit legacy compatibility policy');
		}
	}
}

function requiredCommand(job, command) {
	const step = job?.steps?.find(step => step.run === command);
	assert.ok(step && !Object.hasOwn(step, 'if') && !Object.hasOwn(step, 'continue-on-error'), 'Missing unconditional CI command: ' + command);
}

function runtimeJob(job, expression = matrixExpression, condition) {
	assert.ok(job && !Object.hasOwn(job, 'continue-on-error'), 'Runtime CI job must fail on errors');
	assert.equal(job.if, condition, 'Runtime CI job has an unexpected execution condition');
	assert.equal(job.needs, 'support', 'Runtime CI must depend on the support table');
	assert.equal(job.strategy?.matrix, expression, 'CI matrix must come from the support table');
	assert.equal(job.strategy?.['fail-fast'], false, 'All runtime results must be retained');
	const setup = job.steps.find(step => step.uses?.startsWith('actions/setup-node@'));
	assert.equal(setup?.with?.['node-version'], '${{ matrix.node }}', 'Runtime CI must use its matrix Node');
	assert.ok(!Object.hasOwn(setup, 'if') && !Object.hasOwn(setup, 'continue-on-error'), 'Runtime selection must be unconditional');
}

export function validateSupport(input, today) {
	const matrices = supportMatrices(input, today);
	validatePeerCoverage(input, today);
	const { table, workflow, chaos } = input;
	assert.ok(workflow.on.pull_request !== undefined && workflow.on.push?.branches.includes('dev') && workflow.on.schedule?.length, 'Support checks must run on PRs, dev and a schedule');
	for (const flow of [workflow, chaos]) {
		const producer = flow.jobs.support;
		assert.ok(producer && !Object.hasOwn(producer, 'if') && !Object.hasOwn(producer, 'continue-on-error'), 'Support matrix producer must run unconditionally');
		assert.equal(producer.steps.find(step => step.uses?.startsWith('actions/setup-node@'))?.with?.['node-version'], table.node.baseline, 'Matrix producer must use the exact baseline');
		requiredCommand(producer, 'npm ci');
		requiredCommand(producer, 'node scripts/check-ci-support.js --github-output');
		assert.equal(producer.outputs.node, '${{ steps.support.outputs.node }}');
		assert.equal(producer.outputs.peers, '${{ steps.support.outputs.peers }}');
		assert.equal(producer.steps.find(step => step.run === 'node scripts/check-ci-support.js --github-output').id, 'support');
	}
	for (const name of ['verify', 'smoke', 'kit']) runtimeJob(workflow.jobs[name]);
	runtimeJob(workflow.jobs.peers, peersExpression, peerSchedule);
	requiredCommand(workflow.jobs.peers, 'node scripts/run-peer-compat.js --combination "${{ matrix.combination }}" --target "${{ matrix.target }}" --edge "${{ matrix.edge }}"');
	requiredCommand(workflow.jobs.verify, 'npm exec -- svelte-adapter-uws-preflight');
	requiredCommand(workflow.jobs.verify, 'npm run verify:pr');
	requiredCommand(workflow.jobs.verify, 'npm run verify:browser');
	requiredCommand(workflow.jobs.verify, 'npm run test:smooth-stack');
	requiredCommand(workflow.jobs.smoke, 'npm run smoke');
	requiredCommand(workflow.jobs.kit, 'npm run test:kit');
	runtimeJob(chaos.jobs['recovery-chaos']);
	requiredCommand(chaos.jobs['recovery-chaos'], 'npm run test:lifecycle');
	requiredCommand(chaos.jobs['recovery-chaos'], 'npm run test:chaos:parallel');
	requiredCommand(chaos.jobs['recovery-chaos'], 'npm exec -- playwright test --config test/chaos/playwright.config.js recovery.spec.js --reporter=line,junit');
	return matrices;
}

export function renderSupport(input) {
	const { table, pkg } = input;
	const { node, peers } = supportMatrices(input, table.checkedOn);
	return '# Runtime and peer coverage\n\n' +
		'CI tests the current checkout on Linux (Ubuntu 24.04). The package and recovery workflows run on pull requests, pushes to main/dev and nightly schedules. The release workflow retains its Windows verification.\n\n' +
		'`docs/ci-support.v1.json` records upstream lifecycle data and compatible peer majors. `node scripts/check-ci-support.js` derives both matrices from that table and the package/fixture manifests. It refuses stale dates, an EOL Node baseline, omitted majors, disconnected matrices and skipped runtime commands. The table was checked on ' + table.checkedOn + ' and must be checked again by ' + table.checkBy + '.\n\n' +
		'| Node leg | Upstream end of support |\n| --- | --- |\n' +
		node.include.map(row => '| ' + row.node + ' | ' + table.node.lines.find(line => line.major === semver.major(row.node.replace('.x', '.0.0'))).end + ' |').join('\n') + '\n\n' +
		'The exact patch is the baseline; `.x` selects the newest patch in each maintained major admitted by `engines.node` (`' + pkg.engines.node + '`). Every leg runs the unit, simulation, browser/DevTools, scaffold, native smooth-stack, smoke, locked Kit, production lifecycle and recovery-chaos checks. Native preflight is required before the unit suite. A missing native binary fails the leg.\n\n' +
		'| SvelteKit major | Svelte major | Vite major | Vite plugin major | Adapter major |\n| --- | --- | --- | --- | --- |\n' +
		table.combinations.map(row => '| ' + [row.kit, row.svelte, row.vite, row.plugin, row.adapter].join(' | ') + ' |').join('\n') + '\n\n' +
		'On pushes to dev, nightly schedules and explicit workflow dispatches, every row tests each of SvelteKit, Svelte, Vite and the adapter as a separate target, at its floor and latest version, crossed with every maintained Node major (' + peers.include.length + ' jobs). Pull requests retain all four runtime legs and their locked peer fixtures; the larger peer product runs automatically after integration into dev. The target boundary is selected first, then the newest compatible companions; testing the Kit floor does not replace testing the Svelte floor. For example, Svelte 4.0.0 runs with a newer Kit 2 that admits it, while Kit 2.0.0 runs with a newer Svelte 4 that satisfies its own minimum. The adapter stays inside `' + pkg.peerDependencies['svelte-adapter-uws'] + '`. Registry metadata, peer ranges and engines determine the exact tuple without `--force` or `--legacy-peer-deps`. Each job retains its target, exact requested and installed versions, logs and runtime reports. The complete combination set is checked independently against the locked Kit/adapter manifests and recorded Vite-plugin peer contracts.\n\n' +
		'Svelte 5 rows run real production and development servers, cold WebSocket RPC, browser stores, shared HTTP/WebSocket state, DevTools and HMR. Kit 3 also tests wrapped and omitted adapter configurations. The existing adapter-version-specific runtime exceptions remain visible in the Kit reports. Svelte 4 rows build and type-check a production application, exercise store operations, and verify RPC and updates in two browsers plus reload.\n\n' +
		'Upstream has no dated EOL schedule for Svelte, SvelteKit or the adapter, so their dates are null in the table. Vite uses a rolling policy: 6/7/8 receive updates as of the recorded date; Vite 5 is explicitly legacy compatibility coverage required by the supported Svelte 4 path. That legacy row does not claim upstream security support. Published package ranges remain unchanged.\n\n' +
		'For one installed consumer, run `node scripts/run-peer-compat.js --combination kit2-svelte5-vite6-adapter0 --target svelte --edge floor` after installing root dependencies and Playwright Chromium. This creates an isolated application under `test-results`, resolves exact registry versions, installs with strict peer and engine checks, and retains its evidence there. Other targets are `kit`, `vite` and `adapter`; use `--edge latest` for the other boundary.\n';
}

if (isScriptEntry(import.meta.url)) {
	const input = readSupport();
	const matrices = validateSupport(input);
	const document = resolve(root, 'docs/ci-support.md');
	const content = renderSupport(input);
	if (process.argv.includes('--write')) writeFileSync(document, content);
	assert.equal(readFileSync(document, 'utf8').replace(/\r\n/g, '\n'), content, 'CI support documentation is stale; run node scripts/check-ci-support.js --write');
	if (process.argv.includes('--github-output')) {
		assert.ok(process.env.GITHUB_OUTPUT, 'GITHUB_OUTPUT is required');
		for (const [name, matrix] of Object.entries(matrices)) appendFileSync(process.env.GITHUB_OUTPUT, name + '=' + JSON.stringify(matrix) + '\n');
	} else console.log('CI support: ' + matrices.node.include.length + ' runtime legs and ' + matrices.peers.include.length + ' peer combinations');
}
