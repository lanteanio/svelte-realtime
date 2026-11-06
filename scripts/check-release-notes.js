// Gate the consumer summary that leads every new release block of CHANGELOG.md.
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { anchorsOf } from './check-links.js';
import { CANDIDATE, NOT_PUBLISHED } from './check-release-ledger.js';
import { compareVersions, versionPattern } from './release-policy.js';
import { isScriptEntry } from './script-entry.js';

const START = '<!-- consumer-release-summary:start -->';
const END = '<!-- consumer-release-summary:end -->';
const FIELDS = ['Affects', 'Action', 'Requires', 'Compatibility', 'Detail'];
const KINDS = ['Added', 'Changed', 'Fixed'];
const ROOT = new URL('../', import.meta.url);
const DOCS_ROOT = new URL('docs/', ROOT);
const RELEASES_ROOT = new URL('docs/releases/', ROOT);

// Release blocks up to and including this version are frozen as written. The
// Unreleased block and every dated release after it lead with a consumer
// summary and keep each engineering bullet at or under the bound; split an
// oversized bullet into focused bullets instead of raising the bound.
export const SUMMARY_BASELINE = '0.6.0-next.91';
const MAX_ENGINEERING_BULLET_CHARS = 2000;

function markdownWords(value) {
	const visible = value.replace(/\[([^\]]+)\]\([^\s)]+\)/g, '$1').replace(/[`*_]/g, ' ');
	return visible.match(/[\p{L}\p{N}][\p{L}\p{N}'-]*/gu)?.length ?? 0;
}

function oneSentence(value) {
	return (value.match(/[.!?](?=\s|$)/g) ?? []).length === 1 && /[.!?]$/.test(value);
}

function validCalendarDate(value) {
	const parsed = new Date(value + 'T00:00:00.000Z');
	return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/** The Unreleased block and every dated release block, newest first, with their bodies. */
export function releaseBlocks(source) {
	const normalized = source.replace(/\r\n/g, '\n');
	const headings = [...normalized.matchAll(/^## \[([^\]]+)\](?: - (\d{4}-\d{2}-\d{2}))?$/gm)];
	const blocks = [];
	const seen = new Set();
	for (const [index, heading] of headings.entries()) {
		const [line, version, date] = heading;
		if (version === 'Unreleased') {
			if (date || index !== 0) throw new Error('CHANGELOG must open with one undated ## [Unreleased] heading');
		} else {
			if (!date || !versionPattern.test(version)) throw new Error('CHANGELOG contains a malformed release heading: ' + line);
			if (!validCalendarDate(date)) throw new Error('CHANGELOG release date is not a real calendar date: ' + date);
			if (seen.has(version)) throw new Error('CHANGELOG contains duplicate release version: ' + version);
			seen.add(version);
		}
		blocks.push({
			version, date, heading: line,
			body: normalized.slice(heading.index + line.length, headings[index + 1]?.index ?? normalized.length)
		});
	}
	if (blocks[0]?.version !== 'Unreleased') throw new Error('CHANGELOG must open with one undated ## [Unreleased] heading');
	return blocks;
}

/** Blocks the summary contract governs: Unreleased with content, then dated releases after the baseline. */
export function governedBlocks(source) {
	return releaseBlocks(source).filter((block) => block.version === 'Unreleased'
		? /^### /m.test(block.body)
		: compareVersions(block.version, SUMMARY_BASELINE) > 0);
}

/**
 * GitHub's heading slug for the plain-text release headings:
 * `## [0.6.0-next.92] - 2026-11-01` produces `060-next92---2026-11-01`.
 */
function githubSlug(headingText) {
	return headingText.trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-');
}

function releaseAnchor(block) {
	return githubSlug(block.heading.replace(/^#+[ \t]*/, ''));
}

/** Top-level engineering bullets with their indented continuation lines. */
function engineeringBullets(body) {
	const bullets = [];
	let current = null;
	for (const line of body.split('\n')) {
		if (line.startsWith('- ')) {
			if (current !== null) bullets.push(current);
			current = line;
		} else if (current !== null && /^[ \t]+\S/.test(line)) {
			current += '\n' + line;
		} else if (current !== null) {
			bullets.push(current);
			current = null;
		}
	}
	if (current !== null) bullets.push(current);
	return bullets;
}

/**
 * The release-status marker the ledger reads from a dated block's first line,
 * if the block carries one. Only a dated block may carry it, and only once.
 */
function statusMarker(block, lead) {
	if (block.version === 'Unreleased') return undefined;
	const marker = lead.trim();
	return marker === CANDIDATE || marker === NOT_PUBLISHED ? marker : undefined;
}

/** Validate one governed block's consumer summary and return its entries. */
export function validateBlockSummary(block) {
	const name = block.version === 'Unreleased' ? 'Unreleased' : block.version;
	const release = block.body;
	if (release.split(START).length !== 2 || release.split(END).length !== 2) {
		throw new Error(`${name} must contain one consumer summary marker pair`);
	}
	const start = release.indexOf(START);
	const end = release.indexOf(END);
	if (end <= start) throw new Error(`${name} consumer summary markers are out of order`);
	const lead = release.slice(0, start);
	if (lead.trim() !== '' && statusMarker(block, lead) === undefined) throw new Error(`${name} consumer summary must be the first content in the block, after at most the release-status marker`);
	const after = release.slice(end + END.length).trimStart();
	if (!after.startsWith('### ')) throw new Error(`${name} consumer summary must precede engineering detail`);

	const summary = release.slice(start + START.length, end).trim();
	if (/[<>]/.test(summary)) throw new Error(`${name} consumer summary cannot hide content in raw HTML`);
	const lines = summary.split('\n');
	if (lines.shift() !== '### Consumer summary') throw new Error(`${name} consumer summary heading is required`);
	const entries = [];
	let index = 0;
	while (index < lines.length) {
		while (lines[index]?.trim() === '') index++;
		if (index >= lines.length) break;
		if (!lines[index].startsWith('- ')) throw new Error(`${name} consumer summary contains prose outside an entry`);
		let lead = lines[index].slice(2).trim();
		index++;
		while (index < lines.length && /^  (?!- )/.test(lines[index])) {
			lead += ' ' + lines[index].trim();
			index++;
		}
		const match = lead.match(/^\*\*(Added|Changed|Fixed): ([^.]+)\.\*\* (.+)$/);
		if (!match) throw new Error(`${name} consumer entry must lead with Added, Changed, or Fixed plus a capability`);
		const [, kind, capability, outcome] = match;
		const count = markdownWords(lead);
		if (count < 40 || count > 60) throw new Error(`${kind}: ${capability} lead has ${count} words; expected 40-60`);
		if (!oneSentence(outcome)) throw new Error(`${kind}: ${capability} must have one outcome sentence`);
		const values = {};
		for (const field of FIELDS) {
			const fieldMatch = (lines[index] ?? '').match(/^  - \*\*([^:]+):\*\* (.+)$/);
			if (!fieldMatch || fieldMatch[1] !== field) throw new Error(`${kind}: ${capability} must provide ${FIELDS.join('/')} in order`);
			values[field] = fieldMatch[2];
			index++;
		}
		if (!new RegExp(`^\\[[^\\]]+\\]\\(#${kind.toLowerCase()}\\)\\.$`).test(values.Detail)) {
			throw new Error(`${kind}: ${capability} detail must link to #${kind.toLowerCase()}`);
		}
		entries.push({ kind, capability, outcome, ...values });
	}
	if (entries.length === 0) throw new Error(`${name} consumer summary must contain at least one entry`);
	for (let i = 1; i < entries.length; i++) {
		if (KINDS.indexOf(entries[i].kind) < KINDS.indexOf(entries[i - 1].kind)) {
			throw new Error(`${name} consumer summary entries must be grouped in Keep-a-Changelog order`);
		}
	}
	// Coverage is required exactly for the kind sections the block contains.
	for (const kind of KINDS) {
		const covered = entries.some((entry) => entry.kind === kind);
		const present = new RegExp(`^### ${kind}$`, 'm').test(after);
		if (present && !covered) throw new Error(`${name} consumer summary is missing ${kind} coverage`);
		if (covered && !present) throw new Error(`${name} consumer summary links to missing ${kind} detail`);
	}
	const capabilities = new Set(entries.map((entry) => `${entry.kind}:${entry.capability.toLowerCase()}`));
	if (capabilities.size !== entries.length) throw new Error(`${name} consumer summary capabilities must be unique`);
	for (const bullet of engineeringBullets(after)) {
		if (bullet.length > MAX_ENGINEERING_BULLET_CHARS) {
			throw new Error(
				`${name} engineering bullet starting "${bullet.slice(2, 62)}" has ${bullet.length} characters; ` +
				`blocks after ${SUMMARY_BASELINE} bound each bullet to ${MAX_ENGINEERING_BULLET_CHARS} characters, so split it into focused bullets`
			);
		}
	}
	return entries;
}

/** Every governed block's entries, keyed by block name. */
export function validateReleaseSummaries(source) {
	return governedBlocks(source).map((block) => ({ block, entries: validateBlockSummary(block) }));
}

/** The newest dated release the page contract covers, if one is newer than the baseline. */
function currentRelease(source, packageVersion) {
	const dated = releaseBlocks(source).filter((block) => block.version !== 'Unreleased');
	const newest = dated[0];
	if (!newest || compareVersions(newest.version, SUMMARY_BASELINE) <= 0) return undefined;
	if (packageVersion !== undefined && newest.version !== packageVersion) {
		throw new Error(`newest CHANGELOG release ${newest.version} does not match package.json version ${packageVersion}`);
	}
	return newest;
}

export function releasePagePath(version) {
	if (!versionPattern.test(version)) throw new Error('release page version is not a safe exact SemVer: ' + version);
	return `docs/releases/${version}.md`;
}

function isContained(parent, child) {
	const fromParent = relative(parent, child);
	return fromParent !== '' && fromParent !== '..' && !fromParent.startsWith('..' + sep) && !isAbsolute(fromParent);
}

/** Resolve the generated page only after proving it stays inside docs/releases. */
function releasePageTarget(version) {
	const relativePath = releasePagePath(version);
	const releasesPath = resolve(fileURLToPath(RELEASES_ROOT));
	const targetPath = resolve(fileURLToPath(new URL(relativePath, ROOT)));
	if (dirname(targetPath) !== releasesPath || !isContained(releasesPath, targetPath)) {
		throw new Error('release page target escapes docs/releases: ' + relativePath);
	}
	const repositoryPath = realpathSync(fileURLToPath(ROOT));
	const docsPath = resolve(fileURLToPath(DOCS_ROOT));
	if (existsSync(docsPath) && !isContained(repositoryPath, realpathSync(docsPath))) throw new Error('resolved docs directory escapes the repository');
	if (existsSync(releasesPath) && !isContained(repositoryPath, realpathSync(releasesPath))) {
		throw new Error('resolved docs/releases directory escapes the repository');
	}
	return { relative: relativePath, target: pathToFileURL(targetPath) };
}

/**
 * Summary links are written relative to the repository root, where
 * CHANGELOG.md lives; the page sits two directories below it, so a relative
 * file link is rebased onto it. Anchors, absolute paths and URLs are left as
 * written; an anchor then points into the page itself, and check-links
 * reports one that does not resolve there.
 * @param {string} text
 */
export function rebaseSummaryLinks(text) {
	return String(text).replace(/\]\((?![a-z][a-z0-9+.-]*:|#|\/)(?:\.\/)?([^)\s]+)\)/gi, '](../../$1)');
}

/** Render the consumer page for a dated release from its validated summary. */
export function renderReleasePage(block) {
	const entries = validateBlockSummary(block);
	const marker = statusMarker(block, block.body.slice(0, block.body.indexOf(START)));
	const status = marker === undefined ? `Released ${block.date}.`
		: marker === CANDIDATE ? `Release candidate dated ${block.date}; not published to npm.`
			: `Dated ${block.date}; superseded before release and not published to npm.`;
	// Detail links pin this release's own heading anchor; `#added` resolves to
	// whichever block is newest when the page is read.
	const anchor = releaseAnchor(block);
	const lines = [
		`# svelte-realtime ${block.version}`,
		'',
		status,
		'',
		'[README](../../README.md) | [migration guide](../../MIGRATION.md) | [complete changelog](../../CHANGELOG.md)',
		'',
		'This versioned consumer page is generated from the structured summary in the',
		'complete changelog. Edit that summary, then regenerate this page; do not maintain',
		'a second release narrative here.',
		'',
		'## Consumer changes',
		''
	];
	for (const entry of entries) {
		lines.push(
			`### ${entry.kind}: ${entry.capability}`,
			'',
			rebaseSummaryLinks(entry.outcome),
			'',
			`- **Affects:** ${rebaseSummaryLinks(entry.Affects)}`,
			`- **Action:** ${rebaseSummaryLinks(entry.Action)}`,
			`- **Requires:** ${rebaseSummaryLinks(entry.Requires)}`,
			`- **Compatibility:** ${rebaseSummaryLinks(entry.Compatibility)}`,
			`- **Engineering detail:** [${entry.kind} for ${block.version} in the complete changelog](../../CHANGELOG.md#${anchor}).`,
			''
		);
	}
	return lines.join('\n');
}

/** Pages in docs/releases must name a dated release and pin its own heading anchor. */
export function validateReleasePages(source, pages) {
	const blocks = releaseBlocks(source).filter((block) => block.version !== 'Unreleased');
	const anchors = anchorsOf(source);
	let links = 0;
	for (const [name, text] of pages) {
		const block = blocks.find((candidate) => candidate.version + '.md' === name);
		if (!block) throw new Error(`docs/releases/${name} does not match any dated CHANGELOG release`);
		const anchor = releaseAnchor(block);
		if (!anchors.has(anchor)) throw new Error(`CHANGELOG.md produces no #${anchor} anchor for docs/releases/${name}`);
		for (const match of text.matchAll(/\]\(\.\.\/\.\.\/CHANGELOG\.md#([^)]+)\)/g)) {
			links++;
			if (match[1] !== anchor) {
				throw new Error(`docs/releases/${name} links to ../../CHANGELOG.md#${match[1]}; release page detail links must pin #${anchor}`);
			}
		}
	}
	return { pages: pages.size, links };
}

/** Entries in docs/releases that are not markdown page files (macOS .DS_Store aside). */
export function strayReleaseEntries(entries) {
	return [...entries].filter((entry) => entry.name !== '.DS_Store')
		.filter((entry) => !entry.isFile() || !entry.name.endsWith('.md')).map((entry) => entry.name).sort();
}

/** README.md and MIGRATION.md each carry the current-release route. */
export function validateReleaseRouteLinks(version, documents) {
	const link = './' + releasePagePath(version);
	const missing = Object.keys(documents).filter((name) => !documents[name].includes(link));
	if (missing.length) {
		throw new Error(`${missing.join(' and ')} must contain the current-release link ${link}; update both after a version bump`);
	}
	return link;
}

function readPages() {
	const pages = new Map();
	const path = fileURLToPath(RELEASES_ROOT);
	if (!existsSync(path)) return pages;
	for (const name of readdirSync(path)) if (name.endsWith('.md')) pages.set(name, readFileSync(new URL(name, RELEASES_ROOT), 'utf8'));
	return pages;
}

function main() {
	const source = readFileSync(new URL('CHANGELOG.md', ROOT), 'utf8');
	const packageVersion = JSON.parse(readFileSync(new URL('package.json', ROOT), 'utf8')).version;
	const governed = validateReleaseSummaries(source);
	const releasesPath = fileURLToPath(RELEASES_ROOT);
	const strays = strayReleaseEntries(existsSync(releasesPath) ? readdirSync(releasesPath, { withFileTypes: true }) : []);
	if (strays.length) throw new Error('docs/releases holds ' + strays.join(', ') + ', which is not a release page; remove it');
	const current = currentRelease(source, packageVersion);
	const write = process.argv.includes('--write');
	const wanted = new Set();
	if (current) {
		const { relative: path, target } = releasePageTarget(current.version);
		const expected = renderReleasePage(current);
		wanted.add(current.version + '.md');
		if (write) {
			mkdirSync(RELEASES_ROOT, { recursive: true });
			writeFileSync(target, expected);
		} else if (!existsSync(target) || readFileSync(target, 'utf8').replace(/\r\n/g, '\n') !== expected) {
			throw new Error(`${path} is missing or stale; run node scripts/check-release-notes.js --write`);
		}
		validateReleaseRouteLinks(current.version, {
			'README.md': readFileSync(new URL('README.md', ROOT), 'utf8'),
			'MIGRATION.md': readFileSync(new URL('MIGRATION.md', ROOT), 'utf8')
		});
	}
	const pages = readPages();
	const stale = [...pages.keys()].filter((name) => !wanted.has(name) && releaseBlocks(source).some((block) => block.version + '.md' === name));
	for (const name of stale) {
		if (!write) throw new Error(`docs/releases still holds the earlier release page ${name}; run node scripts/check-release-notes.js --write, which removes it`);
		const target = resolve(releasesPath, name);
		if (dirname(target) !== resolve(releasesPath)) throw new Error('release page path leaves docs/releases: ' + name);
		unlinkSync(target);
		pages.delete(name);
		console.log('check-release-notes: removed docs/releases/' + name);
	}
	const checked = validateReleasePages(source, pages);
	const entries = governed.reduce((total, item) => total + item.entries.length, 0);
	console.log(
		`check-release-notes: ${entries} consumer entries across ${governed.map((item) => item.block.version).join(', ') || 'no new blocks'} are action-first and bounded; ` +
		`${checked.pages} release page(s) pin ${checked.links} version anchor(s)`
	);
}

if (isScriptEntry(import.meta.url)) {
	try { main(); } catch (error) { console.error('check-release-notes FAILED: ' + error.message); process.exitCode = 1; }
}
