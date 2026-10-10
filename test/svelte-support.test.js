import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { parse } from 'yaml';
import { readProfile, renderSupport, trackedArtifacts, validateProfile, validateWorkflow } from '../scripts/check-svelte-support.js';

const profile = readProfile();
const workflow = parse(readFileSync(new URL('../.github/workflows/verify.yml', import.meta.url), 'utf8'));

describe('locked Svelte 4 compatibility profile', () => {
	it('pins the actual installed dependency tuple and current packed package', () => {
		expect(() => validateProfile(profile)).not.toThrow();
		const floating = structuredClone(profile);
		floating.pkg.dependencies.svelte = '^4.2.20';
		floating.lock.packages[''].dependencies.svelte = '^4.2.20';
		expect(() => validateProfile(floating)).toThrow(/exact version/);
		const mismatch = structuredClone(profile);
		mismatch.lock.packages['node_modules/svelte'].version = '5.0.0';
		expect(() => validateProfile(mismatch)).toThrow(/lock version drift/);
	});

	it('rejects stale local-package dependency metadata', () => {
		const stale = structuredClone(profile);
		stale.lock.packages['node_modules/svelte-realtime'].peerDependencies.svelte = '^5.0.0';
		expect(() => validateProfile(stale)).toThrow(/metadata drift/);
	});

	it('generates the published support row directly from checked metadata', () => {
		expect(readFileSync(new URL('../docs/svelte-support.md', import.meta.url), 'utf8').replace(/\r\n/g, '\n')).toBe(renderSupport(profile));
		expect(renderSupport(profile)).toContain('| ' + profile.node + ' | ' + profile.pkg.dependencies.svelte + ' |');
	});

	it('requires native preflight before building and checks types, stores and real browsers', () => {
		expect(() => validateWorkflow(workflow)).not.toThrow();
		const missing = structuredClone(workflow);
		missing.jobs.svelte4.steps = missing.jobs.svelte4.steps.filter((step) => step.run !== 'npm run smoke');
		expect(() => validateWorkflow(missing)).toThrow(/CI gates drifted/);
		const reversed = structuredClone(workflow);
		const steps = reversed.jobs.svelte4.steps;
		const preflight = steps.findIndex((step) => step.run === 'npm exec -- svelte-adapter-uws-preflight');
		const build = steps.findIndex((step) => step.run === 'npm run build');
		[steps[preflight], steps[build]] = [steps[build], steps[preflight]];
		expect(() => validateWorkflow(reversed)).toThrow(/CI gates drifted/);
	});

	it('ignores generated directories at any fixture depth and catches force-added artifacts', () => {
		const directory = mkdtempSync(join(tmpdir(), 'svelte-support-'));
		const git = (...args) => execFileSync('git', args, { cwd: directory, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
		try {
			copyFileSync(new URL('../.gitignore', import.meta.url), join(directory, '.gitignore'));
			git('init', '--quiet');
			const artifacts = ['test/fixtures/svelte4/build/server/chunk.js', 'test/fixtures/another/nested/.svelte-kit/output/server.js', 'test/fixtures/svelte4/node_modules/pkg/index.js'];
			for (const path of artifacts) {
				mkdirSync(dirname(join(directory, path)), { recursive: true });
				writeFileSync(join(directory, path), 'export {};\n');
				expect(git('check-ignore', path).trim()).toBe(path);
			}
			expect(trackedArtifacts(directory)).toEqual([]);
			git('add', '--force', '--', ...artifacts);
			expect(trackedArtifacts(directory).sort()).toEqual(artifacts.sort());
		} finally {
			const target = resolve(directory);
			if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('svelte-support-')) throw new Error('Unsafe temporary repository cleanup');
			rmSync(target, { recursive: true, force: true });
		}
	}, 30000);
});
