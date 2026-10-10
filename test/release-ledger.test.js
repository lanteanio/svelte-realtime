import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';
import { CANDIDATE, NOT_PUBLISHED, parseManifest, readBaseline, validateReleaseHistory, validateReleaseLedger } from '../scripts/check-release-ledger.js';

const recordedManifest = readFileSync(new URL('../docs/release-manifest.md', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const recordedChangelog = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const recordedVersion = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
// A stable fixture lets the real package advance and publish without weakening candidate coverage.
const versions = new Set(['0.1.4', '0.1.9', '0.6.0-next.42', '0.5.13']);
// Each real-history fixture composes up to 18 Git commands, each bounded at 30s.
const HISTORY_TIMEOUT = 600000;

const manifest = recordedManifest.split('\n').filter((line) => !line.startsWith('| svelte-realtime |') || versions.has(line.split('|')[2].trim())).join('\n');
const current = '0.6.0-next.91';
const changelog = `## [Unreleased]

## [0.6.0-next.91] - 2026-10-10

${CANDIDATE}

## [0.6.0-next.67] - 2026-07-10

${NOT_PUBLISHED}

## [0.6.0-next.42] - 2026-06-26

## [0.5.13] - 2026-10-10

## [0.1.9] - 2026-03-15

## [0.1.4] - 2026-03-14
`;
const check = (m = manifest, c = changelog, baseline) => validateReleaseLedger(m, c, current, baseline).join('\n');
const firstRow = manifest.split('\n').find((line) => line.startsWith('| svelte-realtime |'));

it('reconciles every reconstructed artifact including previously missing releases', () => {
	expect(validateReleaseLedger(recordedManifest, recordedChangelog, recordedVersion)).toEqual([]);
	const rows = parseManifest(recordedManifest)['Published releases'];
	expect(rows.length).toBeGreaterThanOrEqual(150);
	for (const version of ['0.1.4', '0.5.0', '0.6.0-next.42', '0.6.0-next.43', '0.6.0-next.45', '0.6.0-next.46', '0.6.0-next.88', '0.5.13']) {
		expect(rows.some((row) => row[1] === version)).toBe(true);
	}
});
it('rejects a published version whose heading was folded into another release', () => {
	expect(check(manifest, changelog.replace('## [0.6.0-next.42]', '### [0.6.0-next.42]'))).toContain('Published version has no changelog heading: 0.6.0-next.42');
});
it('rejects unrecorded and duplicate release headings, including archive shortcuts', () => {
	expect(check(manifest, changelog + '\n## [9.0.0] - 2026-10-10\n')).toContain('Unrecorded version lacks');
	expect(check(manifest, changelog + '\n## [0.1.4] - 2026-03-14\n')).toContain('Duplicate changelog heading');
	expect(check(manifest, changelog.replace('## [0.1.9] - 2026-03-15', '## [0.1.9] and earlier'))).toContain('Malformed changelog release heading');
});
it('distinguishes unpublished candidates from published artifacts', () => {
	expect(check(manifest, changelog.replace(NOT_PUBLISHED, ''))).toContain('Unrecorded version lacks');
	expect(check(manifest, changelog.replace(CANDIDATE, ''))).toContain('Unrecorded version lacks');
	expect(check(manifest, changelog.replace('## [0.1.4] - 2026-03-14', `## [0.1.4] - 2026-03-14\n\n${NOT_PUBLISHED}`))).toContain('Published version carries');
	expect(check(manifest, changelog.replace(NOT_PUBLISHED, CANDIDATE))).toContain('Candidate marker must name the current');
});
it('allows the current package version to become published with its marker removed', () => {
	const row = `| svelte-realtime | ${current} | next | ${'a'.repeat(40)} | svelte-realtime@${current} | sha512-${Buffer.alloc(64, 1).toString('base64')} | ${'b'.repeat(40)} | 2026-10-11T00:00:00.000Z | Published after verification. |\n`;
	const updated = manifest.replace('\n\n## Routing,', `\n${row}\n## Routing,`);
	expect(check(updated, changelog.replace(CANDIDATE, ''))).toBe('');
});
it('rejects malformed, duplicate or noncanonical published identities', () => {
	const cases = [
		[firstRow, firstRow + '\n' + firstRow, 'Duplicate published version'],
		['| svelte-realtime | 0.1.4 |', '| another-package | 0.1.4 |', 'Unknown package'],
		['| 0.1.4 |', '| 00.1.4 |', 'exact SemVer'],
		['| 0.1.4 |', '| 0.1.4+build |', 'exact SemVer'],
		['2026-03-14T19:11:25.648Z', '2026-02-30T19:11:25.648Z', 'Invalid Published UTC'],
		['2026-03-14T19:11:25.648Z', '2027-03-14T19:11:25.648Z', 'publication order'],
		[/sha512-[^ |\n]+/, 'sha512-a==', 'Invalid npm integrity'],
		['df5ecbfd0d56799bb401090dfbe32b30da9d53ca', 'unknown', 'Invalid Git head'],
		['| legacy-unrecorded |', '| unknown |', 'Invalid Git head'],
		['| legacy-none |', '| v0.1.4 |', 'Invalid Git tag'],
		['| 0.1.4 | latest |', '| 0.1.4 | next |', 'Invalid target channel']
	];
	for (const [from, to, expected] of cases) expect(check(manifest.replace(from, to)), expected).toContain(expected);
});
it('rejects missing, duplicate and malformed ledger tables', () => {
	expect(check(manifest.replace('## Published releases', '## Releases'))).toContain('Expected one manifest section');
	expect(check(manifest + '\n## Published releases\n')).toContain('Expected one manifest section');
	expect(check(manifest.replace('| npm shasum |', '| wrong field |'))).toContain('Malformed manifest table');
	expect(check(manifest.replace(firstRow, firstRow.replace(' | No release tag.', '')))).toContain('Malformed manifest table');
});
it('rejects deletion, reordering and edits to committed rows while allowing appends', () => {
	expect(check(manifest, changelog, manifest)).toBe('');
	expect(check(manifest.replace(firstRow + '\n', ''), changelog, manifest)).toContain('append-only');
	expect(check(manifest.replace('No release tag.', 'Changed historical note.'), changelog, manifest)).toContain('append-only');
	const lines = manifest.split('\n');
	const index = lines.indexOf(firstRow);
	[lines[index], lines[index + 1]] = [lines[index + 1], lines[index]];
	expect(check(lines.join('\n'), changelog, manifest)).toContain('append-only');
	for (const [heading, row] of [
		['Candidate event log', '| 9.0.0 | proposed | 2026-10-10T12:00:00.000Z | head | tag | latest | review |'],
		['Routing, corrections and rollback events', '| routing-1 | time | routed | - | - | svelte-realtime | latest | old | new | - | evidence | note |']
	]) {
		const start = manifest.indexOf(`## ${heading}`);
		const separator = manifest.indexOf('\n', manifest.indexOf('| ---', start));
		const appended = manifest.slice(0, separator) + '\n' + row + manifest.slice(separator);
		expect(check(appended, changelog, manifest)).toBe('');
		expect(check(manifest, changelog, appended)).toContain(`append-only: ${heading}`);
	}
});
it('reads only the requested Git baseline and fails on an unavailable one', async () => {
	const directory = mkdtempSync(join(tmpdir(), 'realtime-ledger-'));
	// Temporary history must not execute the developer's global repository hooks.
	mkdirSync(join(directory, '.empty-hooks'));
	const git = (...args) => execFileSync('git', ['-c', `core.hooksPath=${join(directory, '.empty-hooks')}`, ...args], { cwd: directory, stdio: 'pipe', timeout: 30000 });
	try {
		git('init', '-q');
		git('-c', 'user.name=Ledger test', '-c', 'user.email=ledger@example.invalid', 'commit', '--allow-empty', '-qm', 'Initial history');
		expect(readBaseline(directory, 'HEAD')).toBeUndefined();
		mkdirSync(join(directory, 'docs'));
		writeFileSync(join(directory, 'docs/release-manifest.md'), manifest);
		git('add', 'docs/release-manifest.md');
		git('-c', 'user.name=Ledger test', '-c', 'user.email=ledger@example.invalid', 'commit', '-qm', 'Record artifacts');
		expect(readBaseline(directory, 'HEAD').replace(/\r\n/g, '\n')).toBe(manifest.replace(/\r\n/g, '\n'));
		expect(readBaseline(directory, 'HEAD^')).toBeUndefined();
		expect(() => readBaseline(directory, 'missing-baseline')).toThrow();
	} finally { await removeFixture(directory); }
}, HISTORY_TIMEOUT);

async function removeFixture(directory) {
	const target = resolve(directory);
	if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('realtime-ledger-')) throw new Error('Unsafe ledger fixture cleanup');
	await rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
async function historyFixture(run, { rootLedger = false } = {}) {
	const directory = mkdtempSync(join(tmpdir(), 'realtime-ledger-'));
	// Temporary history must not execute the developer's global repository hooks.
	mkdirSync(join(directory, '.empty-hooks'));
	const git = (...args) => execFileSync('git', ['-c', `core.hooksPath=${join(directory, '.empty-hooks')}`, ...args], { cwd: directory, encoding: 'utf8', stdio: 'pipe', timeout: 30000 }).trim();
	const commit = (message, text) => {
		if (text !== undefined) writeFileSync(join(directory, 'docs/release-manifest.md'), text);
		git('add', '-A');
		git('-c', 'user.name=Ledger test', '-c', 'user.email=ledger@example.invalid', 'commit', '--allow-empty', '-qm', message);
	};
	try {
		git('init', '-q', '-b', 'main');
		mkdirSync(join(directory, 'docs'));
		if (!rootLedger) commit('Initial history');
		commit('Record artifacts', manifest);
		return await run({ directory, git, commit });
	} finally { await removeFixture(directory); }
}

it('catches a committed rewrite after an unrelated commit instead of trusting HEAD', async () => {
	await historyFixture(({ directory, commit }) => {
		const rewritten = manifest.replace('No release tag.', 'Rewritten identity note.');
		commit('Rewrite recorded identity', rewritten);
		commit('Unrelated followup');
		mkdirSync(join(directory, 'scripts'));
		writeFileSync(join(directory, 'scripts/check-release-ledger.js'), readFileSync(new URL('../scripts/check-release-ledger.js', import.meta.url)));
		writeFileSync(join(directory, 'scripts/script-entry.js'), readFileSync(new URL('../scripts/script-entry.js', import.meta.url)));
		writeFileSync(join(directory, 'package.json'), JSON.stringify({ type: 'module', version: current }));
		writeFileSync(join(directory, 'CHANGELOG.md'), changelog);
		expect(() => execFileSync(process.execPath, ['scripts/check-release-ledger.js'], { cwd: directory, encoding: 'utf8', stdio: 'pipe', timeout: 150000, env: { ...process.env, RELEASE_LEDGER_BASE: 'HEAD' } })).toThrow(/Published releases row 1/);
	});
}, HISTORY_TIMEOUT);

it('audits rewrites on a merged branch even after the branch restores the original rows', async () => {
	await historyFixture(({ directory, git, commit }) => {
		git('checkout', '-qb', 'side');
		commit('Rewrite then restore', manifest.replace('No release tag.', 'Rewritten identity note.'));
		const rewrittenCommit = git('rev-parse', 'HEAD');
		commit('Restore original rows', manifest);
		git('checkout', '-q', 'main');
		git('-c', 'user.name=Ledger test', '-c', 'user.email=ledger@example.invalid', 'merge', '--no-ff', '-qm', 'Merge restored branch', 'side');
		expect(validateReleaseHistory(directory, manifest).join('\n')).toContain(rewrittenCommit);
	});
}, HISTORY_TIMEOUT);

it('accepts committed appends and still checks the working copy against HEAD with an older baseline', async () => {
	await historyFixture(({ directory, commit }) => {
		const marker = '| --- | --- | --- | --- | --- | --- | --- |';
		const appended = manifest.replace(marker, marker + '\n| 9.0.0 | proposed | 2026-10-10T12:00:00.000Z | head | tag | latest | reviewed caf\u00e9 \u{1f680} |');
		commit('Append candidate event', appended);
		commit('Keep history unchanged');
		expect(validateReleaseHistory(directory, appended)).toEqual([]);
		expect(validateReleaseLedger(manifest, changelog, current, readBaseline(directory, 'HEAD~2'))).toEqual([]);
		expect(validateReleaseHistory(directory, manifest).join('\n')).toContain('Candidate event log row 1');
	}, { rootLedger: true });
}, HISTORY_TIMEOUT);

it('rejects deleting and readding the whole ledger', async () => {
	await historyFixture(({ directory, commit }) => {
		rmSync(join(directory, 'docs/release-manifest.md'));
		commit('Remove ledger');
		commit('Restore ledger', manifest);
		expect(validateReleaseHistory(directory, manifest).join('\n')).toContain('deleted the ledger');
	});
}, HISTORY_TIMEOUT);

it('fails closed without complete Git history', async () => {
	await historyFixture(async ({ directory, git }) => {
		const shallow = mkdtempSync(join(tmpdir(), 'realtime-ledger-shallow-'));
		const archive = mkdtempSync(join(tmpdir(), 'realtime-ledger-archive-'));
		try {
			git('clone', '--quiet', '--depth=1', pathToFileURL(directory).href, shallow);
			expect(() => validateReleaseHistory(shallow, manifest)).toThrow('full Git checkout');
			expect(() => validateReleaseHistory(archive, manifest)).toThrow();
		} finally { await removeFixture(shallow); await removeFixture(archive); }
	});
}, HISTORY_TIMEOUT);
