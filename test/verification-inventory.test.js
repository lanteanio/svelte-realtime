import { describe, expect, it } from 'vitest';
import { buildInventory, expandScript } from '../scripts/check-verification-inventory.js';

describe('verification inventory', () => {
	it('expands aggregate scripts and npm lifecycle checks', () => {
		expect(expandScript('verify:pr', { 'verify:pr': 'npm test && npm run sim', pretest: 'npm run check', check: 'node check.js', test: 'vitest run', sim: 'node sim.js' })).toEqual(['node check.js', 'vitest run', 'node sim.js']);
		expect(() => expandScript('check', { check: 'npm run check' })).toThrow('recursive');
	});
	it('detects an added aggregate check and newly unhosted lane', () => {
		const workflow = { jobs: { unit: { steps: [{ run: 'npm test' }] } } };
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
