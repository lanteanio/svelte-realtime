import { describe, expect, it } from 'vitest';
import { buildInventory, expandScript, validateLaneTable } from '../scripts/check-verification-inventory.js';

describe('verification inventory', () => {
	it('expands aggregate scripts and npm lifecycle checks', () => {
		expect(expandScript('verify:pr', { 'verify:pr': 'npm test && npm run sim', pretest: 'npm run check', check: 'node check.js', test: 'vitest run', sim: 'node sim.js' })).toEqual(['node check.js', 'vitest run', 'node sim.js']);
		expect(() => expandScript('check', { check: 'npm run check' })).toThrow('recursive');
	});
	it('detects an added aggregate check and newly unhosted lane', () => {
		const workflow = { on: ['pull_request'], jobs: { unit: { steps: [{ run: 'npm test' }] } } };
		const before = buildInventory({ scripts: { test: 'vitest run', 'test:browser': 'playwright test' } }, { ci: workflow });
		expect(before.notFullyHosted).toEqual(['test:browser']);
		const after = buildInventory({ scripts: { pretest: 'node check.js', test: 'vitest run', 'test:browser': 'playwright test' } }, { ci: workflow });
		expect(after.hosted[0].commands).toContain('node check.js');
		expect(after).not.toEqual(before);
	});
	it('respects step, job and workflow package working directories', () => {
		const pkg = { scripts: { test: 'vitest run' } };
		const inventory = buildInventory(pkg, { ci: { defaults: { run: { 'working-directory': 'test/fixture' } }, jobs: { foreign: { steps: [{ run: 'npm test' }] }, root: { defaults: { run: { 'working-directory': '.' } }, steps: [{ run: 'npm test', 'working-directory': 'other' }, { run: 'npm test' }, { run: 'npm test --prefix test/fixture' }] } } } });
		expect(inventory.hosted).toHaveLength(1);
		expect(inventory.hosted[0].commands).toEqual(['vitest run']);
	});
});


it('records triggers and excludes tag-only, schedule and manual workflows from routine coverage', () => {
 const pkg = {scripts:{test:'vitest run', 'verify:release':'node release.js', smoke:'node smoke.js'}};
 const job = command => ({jobs:{check:{steps:[{run:command}]}}});
 const inventory = buildInventory(pkg, {
  ci: {on:{push:{branches:['dev']}}, ...job('npm test')},
  release: {on:{push:{tags:['v*']}}, ...job('npm run verify:release')},
  schedule: {on:{schedule:[{cron:'0 0 * * *'}]}, ...job('npm run smoke')},
  manual: {on:'workflow_dispatch', ...job('npm run smoke')}
 });
 expect(inventory.notFullyHosted).toEqual(['smoke', 'verify:release']);
 expect(inventory.hosted.find(step => step.workflow === 'release').automatic).toBe(false);
 expect(inventory.workflowTriggers.release).toEqual({push:{tags:['v*']}});
 expect(buildInventory(pkg, {ci:{on:'push', ...job('npm test')}}).notFullyHosted).toEqual(['smoke','verify:release']);
});
it('requires every verification lane and named integration check in the contributor table', () => {
 const scripts = {'verify:new':'node new.js', smoke:'node smoke.js'};
 expect(() => validateLaneTable('## Choose verification by the changed surface\n| Docs | ' + String.fromCharCode(96) + 'npm run smoke' + String.fromCharCode(96) + ' |', scripts)).toThrow('verify:new');
});
