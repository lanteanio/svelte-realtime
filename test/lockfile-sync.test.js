import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, PROCESS_TEST_TIMEOUT, removeFixture } from './process-fixtures.js';
import { checkLockSync, committedLocks, installModes, npmCli, readWorkflows, validateInstallModes, workflowInstalls } from '../scripts/check-lockfiles.js';

const npm = npmCli();

function project() {
	const directory = mkdtempSync(join(tmpdir(), 'lockfile-sync-'));
	mkdirSync(join(directory, 'local'));
	mkdirSync(join(directory, 'app'));
	writeFileSync(join(directory, 'local', 'package.json'), JSON.stringify({ name: 'local-dep', version: '1.0.0' }));
	writeFileSync(join(directory, 'app', 'package.json'), JSON.stringify({ name: 'app', private: true, dependencies: { 'local-dep': 'file:../local' } }));
	return directory;
}

function writeLock(app, ...flags) {
	execFileSync(process.execPath, [npm, 'install', '--package-lock-only', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--prefix', app, ...flags], { cwd: app, stdio: 'pipe' });
}

describe('committed lockfile sync guard', () => {
	it('registers every committed lock and matches the npm ci flags CI uses', () => {
		const locks = committedLocks();
		const installs = workflowInstalls(readWorkflows());
		expect(locks).toEqual(Object.keys(installModes).sort());
		expect(() => validateInstallModes(locks, installs)).not.toThrow();
		expect(installs.filter((install) => install.dir === 'test/fixture').length).toBeGreaterThan(0);
		expect(() => validateInstallModes([...locks, 'test/fixtures/new'], installs)).toThrow(/test\/fixtures\/new\/package-lock\.json has no install mode/);
		const linked = installs.map((install) => install.dir === 'test/fixtures/svelte4' ? { ...install, flags: [] } : install);
		expect(() => validateInstallModes(locks, linked)).toThrow(/svelte4/);
		const packed = installs.map((install) => install.dir === 'test/fixture' ? { ...install, flags: ['--install-links'] } : install);
		expect(() => validateInstallModes(locks, packed)).toThrow(/runs npm ci --install-links in test\/fixture/);
	});

	it('reads the directory and flags of prefixed, multi-line and working-directory installs', () => {
		const installs = workflowInstalls({
			'a.yml': { jobs: {
				one: { steps: [{ run: 'npm ci\nnpm ci --prefix test/fixture' }, { run: 'npm cit' }] },
				two: { defaults: { run: { 'working-directory': 'test/fixtures/svelte4' } }, steps: [{ run: 'npm ci --install-links' }] }
			} }
		});
		expect(installs).toEqual([
			{ workflow: 'a.yml', job: 'one', dir: '.', flags: [] },
			{ workflow: 'a.yml', job: 'one', dir: 'test/fixture', flags: [] },
			{ workflow: 'a.yml', job: 'two', dir: 'test/fixtures/svelte4', flags: ['--install-links'] }
		]);
	});

	it('rejects a lock written in the other install mode and a manifest the lock does not cover', () => {
		const directory = project();
		const app = join(directory, 'app');
		try {
			writeLock(app);
			expect(() => checkLockSync(app, [], { npm })).not.toThrow();

			writeLock(app, '--install-links');
			expect(() => checkLockSync(app, ['--install-links'], { npm })).not.toThrow();
			expect(() => checkLockSync(app, [], { npm, label: 'app' })).toThrow(/app\/package-lock\.json is out of sync[\s\S]*Missing: local-dep@1\.0\.0 from lock file/);

			const local = join(directory, 'local', 'package.json');
			writeFileSync(local, JSON.stringify({ name: 'local-dep', version: '1.0.1' }));
			expect(() => checkLockSync(app, ['--install-links'], { npm, label: 'app' })).toThrow(
				/app\/package-lock\.json records stale manifest data[\s\S]*node_modules\/local-dep records version 1\.0\.0 but file:\.\.\/local is 1\.0\.1[\s\S]*npm install --package-lock-only --install-links --ignore-scripts inside app/
			);
			writeFileSync(local, JSON.stringify({ name: 'local-dep', version: '1.0.0', dependencies: { 'left-pad': '^1.3.0' } }));
			expect(() => checkLockSync(app, ['--install-links'], { npm })).toThrow(/records stale dependencies of file:\.\.\/local/);
			writeFileSync(local, JSON.stringify({ name: 'local-dep', version: '1.0.0' }));
			expect(() => checkLockSync(app, ['--install-links'], { npm })).not.toThrow();

			const appManifest = join(app, 'package.json');
			const unversioned = readFileSync(appManifest, 'utf8');
			writeFileSync(appManifest, JSON.stringify({ ...JSON.parse(unversioned), version: '2.0.0' }));
			expect(() => checkLockSync(app, ['--install-links'], { npm })).toThrow(/its root package records version undefined but package\.json has 2\.0\.0/);
			writeFileSync(appManifest, unversioned);

			const manifest = JSON.parse(readFileSync(join(app, 'package.json'), 'utf8'));
			manifest.dependencies['second-dep'] = 'file:../local';
			writeFileSync(join(app, 'package.json'), JSON.stringify(manifest));
			expect(() => checkLockSync(app, ['--install-links'], { npm })).toThrow(/Missing: second-dep@1\.0\.0 from lock file/);

			delete manifest.dependencies['second-dep'];
			manifest.dependencies['left-pad'] = '^1.3.0';
			writeFileSync(join(app, 'package.json'), JSON.stringify(manifest));
			const emptyCache = '--cache=' + join(directory, 'empty-cache');
			expect(() => checkLockSync(app, ['--install-links', emptyCache], { npm })).toThrow(/not in the lock, so npm needed the registry: \S*left-pad/);
		} finally {
			removeFixture(directory, 'lockfile-sync-');
		}
	}, PROCESS_TEST_TIMEOUT);
});
