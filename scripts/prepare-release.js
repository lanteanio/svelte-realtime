/**
 * Fail closed unless the release job is running from the package's exact,
 * annotated version tag and a clean checkout of the commit that tag names.
 */
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const versionPattern = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?$/;

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packagePath = resolve(root, 'package.json');
const expectedRepository = 'lanteanio/svelte-realtime';
const expectedRepositoryUrl = 'git+https://github.com/lanteanio/svelte-realtime.git';

export function validateReleaseContext(env, pkg, git) {
	const errors = [];
	const expectedTag = pkg.name + '@' + pkg.version;
	if (env.GITHUB_EVENT_NAME !== 'push') errors.push('release event must be push');
	if (env.GITHUB_REF_TYPE !== 'tag') errors.push('release ref type must be tag');
	if (env.GITHUB_REF_NAME !== expectedTag) errors.push('release tag must exactly match package name and version');
	if (env.GITHUB_REF !== 'refs/tags/' + expectedTag) errors.push('release ref must be the exact version tag');
	if (env.GITHUB_REPOSITORY !== expectedRepository) errors.push('release repository identity is wrong');
	if (!/^[0-9a-f]{40}$/.test(env.GITHUB_SHA || '')) errors.push('release event SHA must be a full commit or tag identity');
	if (pkg.name !== 'svelte-realtime') errors.push('package name is not publishable by this workflow');
	if (pkg.private === true) errors.push('private package cannot use the public release workflow');
	if (pkg.repository?.url !== expectedRepositoryUrl) errors.push('package repository URL does not match GitHub identity');
	if (typeof pkg.version !== 'string' || !versionPattern.test(pkg.version)) errors.push('package version is not canonical SemVer');
	const channel = !String(pkg.version).includes('-') ? 'latest' : 'next';
	const sourceBranch = channel === 'latest' ? 'origin/main' : 'origin/dev';
	if (pkg.publishConfig?.tag !== channel) errors.push('publishConfig tag disagrees with version channel');
	if (git.sourceBranch !== sourceBranch || !git.sourceContainsHead) {
		errors.push('release commit is not contained in the required ' + sourceBranch + ' lineage');
	}
	if (git.tagType !== 'tag') errors.push('release version tag must be annotated');
	if (!/^[0-9a-f]{40}$/.test(git.head || '')) errors.push('checked-out HEAD is not a full commit');
	if (git.tagCommit !== git.head) errors.push('checked-out HEAD differs from annotated tag commit');
	// Bind the EVENT revision to the checkout: without this, a workflow run
	// whose checkout resolved something other than the pushed revision would
	// pass every identity check while publishing different bytes. The event
	// SHA is the tag object for an annotated tag push, so either identity
	// (tag object or the commit it points at) must equal what is on disk.
	if (env.GITHUB_SHA !== git.head && env.GITHUB_SHA !== git.tagObject) {
		errors.push('release event SHA is bound to neither the checked-out HEAD nor the annotated tag object');
	}
	if (!git.clean) errors.push('release checkout is dirty at the identity check');
	return errors;
}

function git(args) {
	const result = spawnSync('git', args, {
		cwd: root,
		encoding: 'utf8',
		windowsHide: true
	});
	if (result.error || result.status !== 0) {
		throw new Error('git ' + args.join(' ') + ' failed: ' + (result.error?.message || result.stderr.trim()));
	}
	return result.stdout.trim();
}

function isAncestor(commit, branch) {
	const result = spawnSync('git', ['merge-base', '--is-ancestor', commit, branch], {
		cwd: root,
		encoding: 'utf8',
		windowsHide: true
	});
	if (result.error || (result.status !== 0 && result.status !== 1)) {
		throw new Error('could not verify release lineage: ' + (result.error?.message || result.stderr.trim()));
	}
	return result.status === 0;
}

function main() {
	const pkg = JSON.parse(readFileSync(packagePath, 'utf8'));
	const ref = process.env.GITHUB_REF || '';
	const sourceBranch = !String(pkg.version).includes('-') ? 'origin/main' : 'origin/dev';
	const details = {
		tagType: ref ? git(['cat-file', '-t', ref]) : '',
		tagCommit: ref ? git(['rev-list', '-n', '1', ref]) : '',
		tagObject: ref ? git(['rev-parse', ref]) : '',
		head: git(['rev-parse', 'HEAD']),
		clean: git(['status', '--porcelain=v1']).length === 0,
		sourceBranch,
		sourceContainsHead: isAncestor('HEAD', sourceBranch)
	};
	const errors = validateReleaseContext(process.env, pkg, details);
	if (errors.length > 0) throw new Error(errors.join('\n- '));
	console.log('release identity: ' + pkg.name + '@' + pkg.version + ' at ' + details.head);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		main();
	} catch (error) {
		console.error('release identity check failed:\n- ' + error.message);
		process.exitCode = 1;
	}
}
