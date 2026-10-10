import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { execFileSync, removeFixture } from './process-fixtures.js';
import { main } from '../scripts/check-documentation-contract.js';
import { resizeReadmeManifest, validateGrowthRecords, validateReadmeGrowth } from '../scripts/readme-ratchet.js';

it('records only explicit increases while automatically tightening the limit', () => {
	const baseline = { readmeMaxLines: 20, readmeGrowth: [] };
	expect(() => resizeReadmeManifest(baseline, baseline, 21, false)).toThrow('accepted README growth record');
	const accepted = resizeReadmeManifest(baseline, baseline, 21, true);
	expect(accepted.readmeGrowth).toEqual([{ from: 20, to: 21 }]);
	expect(validateReadmeGrowth(accepted, baseline)).toEqual([]);
	expect(resizeReadmeManifest(accepted, baseline, 21, false)).toEqual(accepted);
	expect(resizeReadmeManifest(baseline, baseline, 19, false).readmeMaxLines).toBe(19);
	expect(validateGrowthRecords({ readmeGrowth: [{ from: 20, to: 20 }] })).not.toEqual([]);
	expect(validateReadmeGrowth({ ...accepted, readmeGrowth: [{ from: 19, to: 21 }] }, baseline).join('\n')).toContain('accepted README growth record');
	expect(validateReadmeGrowth({ readmeMaxLines: 20, readmeGrowth: [] }, accepted).join('\n')).toContain('cannot be edited or removed');
	expect(validateReadmeGrowth({ readmeMaxLines: 20 }, baseline).join('\n')).toContain('cannot be edited or removed');
});

it('rejects unrecorded working and committed growth through the real documentation gate', () => {
	const directory = mkdtempSync(join(tmpdir(), 'realtime-readme-'));
	mkdirSync(join(directory, 'docs'));
	mkdirSync(join(directory, '.empty-hooks'));
	const git = (...args) => execFileSync('git', ['-c', `core.hooksPath=${join(directory, '.empty-hooks')}`, '-c', 'user.name=Documentation test', '-c', 'user.email=docs@example.invalid', ...args], { cwd: directory, stdio: 'pipe' });
	const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
	const manifest = JSON.parse(readFileSync(new URL('../docs/documentation.v1.json', import.meta.url), 'utf8'));
	manifest.readmeMaxLines = readme.split('\n').length;
	manifest.readmeGrowth = [];
	const save = value => writeFileSync(join(directory, 'docs/documentation.v1.json'), JSON.stringify(value, null, 2) + '\n');
	const run = options => main({ directory, log() {}, ...options });
	try {
		for (const file of ['package.json', 'docs/package-exports.md']) writeFileSync(join(directory, file), readFileSync(new URL('../' + file, import.meta.url)));
		writeFileSync(join(directory, 'README.md'), readme);
		save(manifest);
		git('init', '-q'); git('add', 'docs/documentation.v1.json'); git('commit', '-qm', 'Record documentation limit');
		writeFileSync(join(directory, 'README.md'), readme + '\n');
		save({ ...manifest, readmeMaxLines: manifest.readmeMaxLines + 1 });
		expect(() => run()).toThrow('accepted README growth record');
		expect(() => run({ write: true })).toThrow('accepted README growth record');
		run({ write: true, acceptReadmeGrowth: true });
		run();
		const accepted = JSON.parse(readFileSync(join(directory, 'docs/documentation.v1.json'), 'utf8'));
		expect(accepted.readmeGrowth).toEqual([{ from: manifest.readmeMaxLines, to: manifest.readmeMaxLines + 1 }]);
		git('add', 'docs/documentation.v1.json'); git('commit', '-qm', 'Accept documentation growth');
		run();
		writeFileSync(join(directory, 'README.md'), readme + '\n\n');
		save({ ...accepted, readmeMaxLines: accepted.readmeMaxLines + 1 });
		git('add', 'docs/documentation.v1.json'); git('commit', '-qm', 'Raise limit without acceptance');
		git('commit', '--allow-empty', '-qm', 'Unrelated change');
		expect(() => run()).toThrow('accepted README growth record');
		save({ ...accepted, readmeMaxLines: accepted.readmeMaxLines + 1, entryBudgetLines: accepted.entryBudgetLines + 1 });
		git('add', 'docs/documentation.v1.json'); git('commit', '-qm', 'Change routing budget');
		expect(() => run()).toThrow('accepted README growth record');
	} finally { removeFixture(directory, 'realtime-readme-'); }
}, 600_000);
