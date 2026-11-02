import { afterEach, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { checkoutDemoTemplate } from '../src/cli-utils.js';

const directories = [];
const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function fixture() {
	const root = mkdtempSync(join(tmpdir(), 'realtime-demo-pin-'));
	directories.push(root);
	const repository = join(root, 'upstream');
	git(['init', '--initial-branch=main', repository]);
	const commit = text => {
		writeFileSync(join(repository, 'template.txt'), text);
		git(['add', '--', 'template.txt'], repository);
		git(['commit', '-m', 'Update template'], repository);
		return git(['rev-parse', 'HEAD'], repository);
	};
	return { root, repository, commit };
}

it('keeps the same vetted template after the remote default branch moves', () => {
	const { root, repository, commit } = fixture();
	const revision = commit('vetted');
	const run = (file, args, cwd) => { expect(file).toBe('git'); git(args, cwd); };
	const first = join(root, 'first');
	checkoutDemoTemplate({ repository, revision, dest: first, run });
	commit('changed default branch');
	const second = join(root, 'second');
	checkoutDemoTemplate({ repository, revision, dest: second, run });
	expect(readFileSync(join(first, 'template.txt'), 'utf8')).toBe('vetted');
	expect(readFileSync(join(second, 'template.txt'), 'utf8')).toBe('vetted');
	expect(git(['rev-parse', 'HEAD'], second)).toBe(revision);
	expect(readFileSync(join(second, '.git', 'HEAD'), 'utf8').trim()).toBe(revision);
});

it('refuses a mutable revision before invoking git', () => {
	const run = vi.fn();
	expect(() => checkoutDemoTemplate({ repository: 'unused', revision: 'main', dest: 'unused', run })).toThrow('full immutable commit');
	expect(run).not.toHaveBeenCalled();
});

it('does not continue to installation when the fetched identity differs', () => {
	const install = vi.fn();
	const run = vi.fn();
	expect(() => {
		checkoutDemoTemplate({ repository: 'unused', revision: 'a'.repeat(40), dest: 'unused', run, readHead: () => 'b'.repeat(40) });
		install();
	}).toThrow('does not match');
	expect(install).not.toHaveBeenCalled();
	expect(run).toHaveBeenCalledTimes(3);
});
