import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { readSupport, supportMatrices, validateSupport, renderSupport } from '../scripts/check-ci-support.js';
import { resolvePeerVersions } from '../scripts/run-peer-compat.js';

const workflow = parse(readFileSync(new URL('../.github/workflows/verify.yml', import.meta.url), 'utf8'));
const input = readSupport();
const today = '2026-11-01';

describe('runtime coverage', () => {
	it('runs the complete application browser suite on every runtime', () => {
		expect(workflow.jobs.verify.steps.some(step => step.run === 'npm run verify:browser')).toBe(true);
	});
	it('keeps the full peer product on development pushes, nightly and manual runs', () => {
		expect(workflow.jobs.peers.if).toBe("${{ github.event_name == 'schedule' || github.event_name == 'workflow_dispatch' || (github.event_name == 'push' && github.ref == 'refs/heads/dev') }}");
		const changed = structuredClone(input);
		changed.workflow.jobs.peers.if = false;
		expect(() => validateSupport(changed, today)).toThrow(/execution condition/);
	});
	it('rejects peer coverage that never automatically runs on the development branch', () => {
		const changed = structuredClone(input);
		changed.workflow.jobs.peers.if = "${{ github.event_name == 'schedule' || github.event_name == 'workflow_dispatch' }}";
		expect(() => validateSupport(changed, today)).toThrow(/execution condition/);
	});
	it.each(['kit2-svelte5-vite5', 'kit2-svelte5-vite8'])('rejects removing compatible combination %s', id => {
		const changed = structuredClone(input);
		changed.table.combinations = changed.table.combinations.filter(row => 'kit' + row.kit + '-svelte' + row.svelte + '-vite' + row.vite !== id);
		expect(() => validateSupport(changed, today)).toThrow(/combination/);
	});
	it('requires runtime combinations for every supported adapter major', () => {
		const changed = structuredClone(input);
		changed.pkg.peerDependencies['svelte-adapter-uws'] += ' || ^1.0.0';
		changed.table.peers['svelte-adapter-uws'].lines.push({ major: 1, end: null });
		expect(() => validateSupport(changed, today)).toThrow(/adapter/);
	});
	it('derives each supported runtime from the checked support table', () => {
		expect(workflow.jobs.verify.strategy?.matrix).toBe('${{ fromJSON(needs.support.outputs.node) }}');
		expect(workflow.jobs.support?.steps.some(step => step.run === 'node scripts/check-ci-support.js --github-output')).toBe(true);
	});
	it('covers all maintained runtime lines plus the exact baseline', () => {
		const matrices = validateSupport(input, today);
		expect(matrices.node.include).toEqual([{ node: '22.23.2' }, { node: '22.x' }, { node: '24.x' }, { node: '26.x' }]);
		expect(matrices.peers.include).toHaveLength(144);
		for (const node of ['22.x', '24.x', '26.x']) {
			for (const combination of ['kit2-svelte4-vite5', 'kit2-svelte5-vite5', 'kit2-svelte5-vite6', 'kit2-svelte5-vite7', 'kit2-svelte5-vite8', 'kit3-svelte5-vite8']) {
				for (const target of ['kit', 'svelte', 'vite', 'adapter']) for (const edge of ['floor', 'latest']) expect(matrices.peers.include).toContainEqual({ node, combination: combination + '-adapter0', target, edge });
			}
		}
	});
	it('rejects a stale support table and an EOL baseline', () => {
		expect(() => supportMatrices(input, '2027-01-02')).toThrow(/checked dates/);
		const changed = structuredClone(input);
		changed.table.node.baseline = '20.19.0';
		changed.pkg.engines.node = '>=20';
		expect(() => supportMatrices(changed, today)).toThrow(/EOL/);
	});
	it('follows the engines floor without inventing a fixed even-major list', () => {
		const changed = structuredClone(input);
		changed.pkg.engines.node = '>=24';
		changed.table.node.baseline = '24.22.2';
		expect(supportMatrices(changed, today).node.include).toEqual([{ node: '24.22.2' }, { node: '24.x' }, { node: '26.x' }]);
		changed.table.checkBy = '2027-04-25';
		expect(supportMatrices(changed, '2027-04-23').node.include).toContainEqual({ node: '27.x' });
	});
	it.each(['verify', 'smoke', 'kit', 'peers'])('refuses a missing or disconnected %s job', name => {
		const changed = structuredClone(input);
		delete changed.workflow.jobs[name];
		expect(() => validateSupport(changed, today)).toThrow();
		changed.workflow.jobs[name] = structuredClone(input.workflow.jobs[name]);
		changed.workflow.jobs[name].strategy.matrix = { node: ['22.x'] };
		expect(() => validateSupport(changed, today)).toThrow(/support table/);
	});
	it('refuses skipped runtime suites and a recovery job on one pinned runtime', () => {
		const changed = structuredClone(input);
		changed.workflow.jobs.verify.steps.find(step => step.run === 'npm run verify:pr').if = false;
		expect(() => validateSupport(changed, today)).toThrow(/unconditional/);
		const recovery = structuredClone(input);
		recovery.chaos.jobs['recovery-chaos'].steps.find(step => step.uses?.startsWith('actions/setup-node@')).with['node-version'] = '22';
		expect(() => validateSupport(recovery, today)).toThrow(/matrix Node/);
		const browser = structuredClone(input);
		browser.workflow.jobs.verify.steps = browser.workflow.jobs.verify.steps.filter(step => step.run !== 'npm run verify:browser');
		expect(() => validateSupport(browser, today)).toThrow(/verify:browser/);
	});
	it('rejects a newly supported peer major without a runtime combination', () => {
		const changed = structuredClone(input);
		changed.pkg.peerDependencies.svelte += ' || ^6.0.0';
		expect(() => validateSupport(changed, today)).toThrow(/supported majors/);
		changed.table.peers.svelte.lines.push({ major: 6, end: null });
		expect(() => validateSupport(changed, today)).toThrow(/no compatible CI combination/);
	});
	it('rejects missing Vite coverage and an undeclared EOL peer', () => {
		const changed = structuredClone(input);
		changed.table.combinations = changed.table.combinations.filter(row => row.vite !== 7);
		expect(() => validateSupport(changed, today)).toThrow(/Vite has no compatible/);
		const expired = structuredClone(input);
		expired.table.peers.svelte.lines[1].end = '2026-10-01';
		expect(() => validateSupport(expired, today)).toThrow(/EOL line/);
	});
	it('keeps the documentation synchronized with the support table', () => {
		expect(readFileSync(new URL('../docs/ci-support.md', import.meta.url), 'utf8').replace(/\r\n/g, '\n')).toBe(renderSupport(input));
	});
});

const metadata = Object.fromEntries([
	['@sveltejs/kit', [
		{ version: '2.0.0', peerDependencies: { svelte: '^4.0.9', vite: '^5.0.3', '@sveltejs/vite-plugin-svelte': '^3.0.0' } },
		{ version: '2.70.3', peerDependencies: { svelte: '^4.0.0 || ^5.0.0', vite: '^5.0.3 || ^6.0.0', '@sveltejs/vite-plugin-svelte': '^3.0.0 || ^5.0.0' } }
	]],
	['@sveltejs/vite-plugin-svelte', [
		{ version: '3.0.0', peerDependencies: { svelte: '^4.0.0', vite: '^5.0.0' } },
		{ version: '3.1.2', peerDependencies: { svelte: '^4.0.0', vite: '^5.0.0' } },
		{ version: '5.0.0', peerDependencies: { svelte: '^5.0.0', vite: '^6.0.0' } }
	]],
	['svelte', [{ version: '4.0.0' }, { version: '4.0.9' }, { version: '4.2.20' }, { version: '5.0.0' }]],
	['vite', [{ version: '5.0.0' }, { version: '5.0.3' }, { version: '5.4.21' }, { version: '6.0.0' }, { version: '6.4.5', engines: { node: '>=24' } }]],
	['svelte-adapter-uws', [{ version: '0.5.16' }, { version: '0.6.0-next.96' }, { version: '0.6.0-next.97' }, { version: '0.7.0' }]]
].map(([name, versions]) => [name, { versions: Object.fromEntries(versions.map(row => [row.version, row])) }]));

describe('peer version boundaries', () => {
	it('tests the actual Svelte floor with newer compatible Kit companions', () => {
		const versions = resolvePeerVersions({ kit: 2, svelte: 4, vite: 5, plugin: 3, adapter: 0 }, input.pkg, metadata, 'floor', '22.23.2', 'svelte');
		expect(versions.svelte).toBe('4.0.0');
		expect(versions['@sveltejs/kit']).toBe('2.70.3');
	});
	it.each([
		['kit', '@sveltejs/kit', '2.0.0'], ['svelte', 'svelte', '4.0.0'], ['vite', 'vite', '5.0.3'], ['adapter', 'svelte-adapter-uws', '0.6.0-next.96']
	])('tests the %s floor independently of companion floors', (target, name, expected) => {
		const versions = resolvePeerVersions({ kit: 2, svelte: 4, vite: 5, plugin: 3, adapter: 0 }, input.pkg, metadata, 'floor', '22.23.2', target);
		expect(versions[name]).toBe(expected);
	});
	it('uses the latest allowed train without following an incompatible adapter major', () => {
		const versions = resolvePeerVersions({ kit: 2, svelte: 4, vite: 5, plugin: 3, adapter: 0 }, input.pkg, metadata, 'latest', '22.23.2', 'adapter');
		expect(versions.svelte).toBe('4.2.20');
		expect(versions.vite).toBe('5.4.21');
		expect(versions['svelte-adapter-uws']).toBe('0.6.0-next.97');
	});
	it('selects compatible frameworks and respects each runtime engine', () => {
		const row = { kit: 2, svelte: 5, vite: 6, plugin: 5, adapter: 0 };
		expect(resolvePeerVersions(row, input.pkg, metadata, 'floor', '22.23.2', 'kit')['@sveltejs/kit']).toBe('2.70.3');
		expect(resolvePeerVersions(row, input.pkg, metadata, 'latest', '22.23.2', 'vite').vite).toBe('6.0.0');
		expect(resolvePeerVersions(row, input.pkg, metadata, 'latest', '24.22.2', 'vite').vite).toBe('6.4.5');
	});
	it('fails a genuinely unsatisfiable graph instead of accepting npm peer overrides', () => {
		expect(() => resolvePeerVersions({ kit: 2, svelte: 4, vite: 6, plugin: 5, adapter: 0 }, input.pkg, metadata, 'floor', '22.23.2', 'kit')).toThrow(/No compatible published peer tuple/);
	});
});
