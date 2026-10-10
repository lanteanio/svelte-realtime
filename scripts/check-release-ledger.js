// Reconcile recorded npm identities without contacting the registry.
import { isScriptEntry } from './script-entry.js';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = 'docs/release-manifest.md';
export const NOT_PUBLISHED = '*Not published to npm; superseded before release.*';
export const CANDIDATE = '*Not published to npm; release candidate.*';
const TABLES = {
	'Candidate event log': ['Candidate', 'Event', 'Event UTC', 'Git head', 'Planned tag', 'Target channel', 'Evidence'],
	'Published releases': ['Package', 'Version', 'Target channel', 'Git head', 'Git tag', 'npm integrity', 'npm shasum', 'Published UTC', 'Notes'],
	'Routing, corrections and rollback events': ['Event ID', 'Event UTC', 'Event', 'Corrected event', 'Corrected UTC', 'Package', 'Channel', 'From version', 'To version', 'Corrects event', 'Evidence', 'Notes']
};
const numeric = '(?:0|[1-9][0-9]*)';
const identifier = `(?:${numeric}|[0-9]*[A-Za-z-][0-9A-Za-z-]*)`;
const versionPattern = new RegExp(`^${numeric}\\.${numeric}\\.${numeric}(?:-${identifier}(?:\\.${identifier})*)?$`);
const hashPattern = /^[0-9a-f]{40}$/;

function cells(line) { return line.split('|').slice(1, -1).map((cell) => cell.trim()); }
function utc(value) {
	return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
		Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
function integrity(value) {
	if (!/^sha512-[A-Za-z0-9+/]{86}==$/.test(value)) return false;
	return Buffer.from(value.slice(7), 'base64').toString('base64') === value.slice(7);
}

export function parseManifest(source) {
	const lines = source.replace(/\r\n/g, '\n').split('\n');
	const tables = {};
	for (const [name, headers] of Object.entries(TABLES)) {
		const heading = `## ${name}`;
		const start = lines.indexOf(heading);
		if (start < 0 || lines.lastIndexOf(heading) !== start) throw new Error(`Expected one manifest section: ${name}`);
		const following = lines.findIndex((line, index) => index > start && line.startsWith('## '));
		const section = lines.slice(start + 1, following < 0 ? lines.length : following);
		const table = section.filter((line) => line.startsWith('|'));
		if (table.length < 2 || table.some((line) => !line.endsWith('|') || cells(line).length !== headers.length) ||
			JSON.stringify(cells(table[0])) !== JSON.stringify(headers) || !cells(table[1]).every((cell) => /^:?-{3,}:?$/.test(cell))) {
			throw new Error(`Malformed manifest table: ${name}`);
		}
		tables[name] = table.slice(2).map((line) => cells(line));
	}
	return tables;
}

export function parseHeadings(source) {
	const lines = source.replace(/\r\n/g, '\n').split('\n');
	const headings = [];
	for (let index = 0; index < lines.length; index++) {
		if (!lines[index].startsWith('## [')) continue;
		if (lines[index] === '## [Unreleased]') continue;
		const match = /^## \[([^\]]+)\] - (\d{4}-\d{2}-\d{2})$/.exec(lines[index]);
		if (!match || !versionPattern.test(match[1]) || !utc(`${match[2]}T00:00:00.000Z`)) {
			throw new Error(`Malformed changelog release heading: ${lines[index]}`);
		}
		let body = index + 1;
		while (lines[body]?.trim() === '') body++;
		headings.push({ version: match[1], marker: lines[body]?.trim() });
	}
	return headings;
}

/** The optional baseline enforces append-only rows in all three event tables. */
export function validateReleaseLedger(manifest, changelog, currentVersion, baseline) {
	let tables, headings, previous;
	try {
		tables = parseManifest(manifest);
		headings = parseHeadings(changelog);
		if (baseline !== undefined) previous = parseManifest(baseline);
	} catch (error) { return [error.message]; }
	const errors = [];
	if (previous) errors.push(...compareRows(previous, tables));
	const published = new Set();
	let priorTime = '';
	for (const values of tables['Published releases']) {
		const row = Object.fromEntries(TABLES['Published releases'].map((field, index) => [field, values[index]]));
		const version = row.Version;
		if (row.Package !== 'svelte-realtime') errors.push(`Unknown package in manifest: ${row.Package}`);
		if (!versionPattern.test(version)) errors.push(`Manifest version must be exact SemVer without build metadata: ${version}`);
		if (published.has(version)) errors.push(`Duplicate published version: ${version}`);
		published.add(version);
		if (!utc(row['Published UTC'])) errors.push(`Invalid Published UTC: ${version}`);
		if (priorTime > row['Published UTC']) errors.push(`Published rows are not in publication order: ${version}`);
		priorTime = row['Published UTC'];
		if (!integrity(row['npm integrity'])) errors.push(`Invalid npm integrity: ${version}`);
		if (!hashPattern.test(row['npm shasum'])) errors.push(`Invalid npm shasum: ${version}`);
		// The legacy 0.5.13 publication has no registry gitHead.
		if (!hashPattern.test(row['Git head']) && !(version === '0.5.13' && row['Git head'] === 'legacy-unrecorded')) {
			errors.push(`Invalid Git head: ${version}`);
		}
		if (row['Git tag'] !== 'legacy-none' && row['Git tag'] !== `svelte-realtime@${version}`) errors.push(`Invalid Git tag: ${version}`);
		if (row['Target channel'] !== (version.includes('-') ? 'next' : 'latest')) errors.push(`Invalid target channel: ${version}`);
		if ((row['Git tag'] === 'legacy-none' || row['Git head'] === 'legacy-unrecorded') && !row.Notes) errors.push(`Legacy identity requires a note: ${version}`);
	}
	const byVersion = new Map();
	for (const heading of headings) {
		if (byVersion.has(heading.version)) errors.push(`Duplicate changelog heading: ${heading.version}`);
		byVersion.set(heading.version, heading);
		const marked = heading.marker === NOT_PUBLISHED || heading.marker === CANDIDATE;
		if (published.has(heading.version)) {
			if (marked) errors.push(`Published version carries a not-published marker: ${heading.version}`);
		} else if (!marked) errors.push(`Unrecorded version lacks a not-published marker: ${heading.version}`);
		if (heading.marker === CANDIDATE && heading.version !== currentVersion) errors.push(`Candidate marker must name the current package version: ${heading.version}`);
	}
	for (const version of published) {
		if (!byVersion.has(version)) errors.push(`Published version has no changelog heading: ${version}`);
	}
	return errors;
}

function compareRows(previous, current) {
	const errors = [];
	for (const name of Object.keys(TABLES)) {
		for (const [index, row] of previous[name].entries()) {
			if (JSON.stringify(row) !== JSON.stringify(current[name][index])) {
				errors.push(`Manifest history is append-only: ${name} row ${index + 1} was removed, reordered or changed`);
			}
		}
	}
	return errors;
}

/** Audit every reachable ledger change, including changes later reverted or merged. */
export function validateReleaseHistory(directory, workingManifest) {
	const options = { cwd: directory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 };
	const git = (...args) => execFileSync('git', args, options).trim();
	if (git('rev-parse', '--is-shallow-repository') !== 'false') {
		throw new Error('Release ledger history requires a full Git checkout; fetch with --unshallow first');
	}
	const head = git('rev-parse', '--verify', 'HEAD^{commit}');
	const commits = git('log', '--full-history', '--reverse', '--format=%H %P', head, '--', manifestPath);
	const edges = commits.split('\n').filter(Boolean).map(line => line.trim().split(/\s+/));
	const revisions = [...new Set([head, ...edges.flat()])];
	// Batch immutable blobs so a long release history does not spawn Git per row.
	const data = execFileSync('git', ['cat-file', '--batch'], {
		...options, stdio: ['pipe', 'pipe', 'pipe'], encoding: undefined, maxBuffer: 64 * 1024 * 1024,
		input: revisions.map(commit => `${commit}:${manifestPath}\n`).join('')
	});
	const cache = new Map();
	let offset = 0;
	for (const commit of revisions) {
		const newline = data.indexOf(10, offset);
		if (newline < 0) throw new Error('Incomplete Git release-ledger batch response');
		const header = data.subarray(offset, newline).toString('utf8');
		offset = newline + 1;
		if (header === `${commit}:${manifestPath} missing`) { cache.set(commit, undefined); continue; }
		const match = /^[0-9a-f]+ blob ([0-9]+)$/.exec(header);
		if (!match) throw new Error(`Invalid Git release-ledger object: ${header}`);
		const end = offset + Number(match[1]);
		if (!Number.isSafeInteger(end) || end >= data.length || data[end] !== 10) throw new Error('Truncated Git release-ledger blob');
		cache.set(commit, parseManifest(data.subarray(offset, end).toString('utf8')));
		offset = end + 1;
	}
	if (offset !== data.length) throw new Error('Unexpected Git release-ledger batch output');
	const errors = [];
	for (const [commit, ...parents] of edges) {
		const current = cache.get(commit);
		for (const parent of parents) {
			const previous = cache.get(parent);
			if (previous === undefined) continue;
			if (current === undefined) errors.push(`Manifest history is append-only: ${commit} deleted the ledger from parent ${parent}`);
			else errors.push(...compareRows(previous, current).map(error => `${commit} against parent ${parent}: ${error}`));
		}
	}
	const previous = cache.get(head);
	if (previous !== undefined) errors.push(...compareRows(previous, parseManifest(workingManifest)));
	return errors;
}

export function readBaseline(directory, ref) {
	const options = { cwd: directory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 };
	const commit = execFileSync('git', ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`], options).trim();
	if (!execFileSync('git', ['ls-tree', '--name-only', commit, '--', manifestPath], options).trim()) return undefined;
	return execFileSync('git', ['show', `${commit}:${manifestPath}`], options);
}

function main() {
	const args = process.argv.slice(2);
	if (args.length && (args.length !== 2 || args[0] !== '--baseline-ref' || !args[1])) throw new Error('Usage: check-release-ledger.js [--baseline-ref <git-ref>]');
	const baselineRef = args[1] || process.env.RELEASE_LEDGER_BASE || 'HEAD';
	const manifest = readFileSync(resolve(root, manifestPath), 'utf8');
	const changelog = readFileSync(resolve(root, 'CHANGELOG.md'), 'utf8');
	const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
	const errors = [
		...validateReleaseLedger(manifest, changelog, pkg.version, baselineRef === 'HEAD' ? undefined : readBaseline(root, baselineRef)),
		...validateReleaseHistory(root, manifest)
	];
	if (errors.length) throw new Error(errors.join('\n'));
	console.log(`release ledger: ${parseManifest(manifest)['Published releases'].length} published identities match changelog headings; committed history is append-only and agrees with ${baselineRef}`);
}
if (isScriptEntry(import.meta.url)) {
	try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
