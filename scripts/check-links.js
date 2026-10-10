#!/usr/bin/env node
// Validate documentation links against local anchors and tracked source routes.
import { isScriptEntry } from './script-entry.js';
import { readFileSync, writeFileSync, existsSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, resolve, join, posix, relative as pathRelative, sep, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import MarkdownIt from 'markdown-it';
import GithubSlugger, { slug } from 'github-slugger';
import { parseFragment } from 'parse5';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const verbose = process.argv.includes('--verbose');
const markdown = new MarkdownIt({ html: true });

const MAIN_TREE_SNAPSHOT = 'docs/main-source-tree.v1.json';

function gitLines(args) {
	return execFileSync('git', ['-C', root, ...args], {
		encoding: 'utf8',
		windowsHide: true,
		stdio: ['ignore', 'pipe', 'ignore']
	}).split('\n').map((line) => line.trim()).filter(Boolean);
}

/**
 * Whether this checkout has a usable git context: the binary exists AND the
 * repository it answers for is THIS one - the same guard trackedMarkdown
 * applies, because a ZIP-extracted copy nested inside some other repository
 * gets confident answers about the wrong tree. Without a usable context the
 * same-repo route validation is skipped (and said so in the summary) rather
 * than crashing or answering from a foreign repo.
 */
let gitUsableCache = null;
export function gitUsable() {
	if (gitUsableCache === null) {
		try {
			const top = gitLines(['rev-parse', '--show-toplevel'])[0] ?? '';
			gitUsableCache = resolve(top).toLowerCase() === root.toLowerCase();
		} catch {
			gitUsableCache = false;
		}
	}
	return gitUsableCache;
}

/**
 * The file list of the STAGED tree (the git index) - what the public dev
 * branch holds once the staged state is committed and pushed. Deliberately
 * not the working directory: an unstaged file cannot green a link it will
 * not accompany, while a staged doc and its staged target travel in the same
 * commit or not at all (so verify-before-commit still works).
 * @returns {Set<string> | null} null without a usable git context
 */
let stagedTreeCache;
export function stagedTree() {
	if (stagedTreeCache === undefined) {
		stagedTreeCache = gitUsable() ? new Set(execFileSync('git', ['-C', root, 'ls-files', '--cached', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean)) : null;
	}
	return stagedTreeCache;
}

/**
 * The checked-in snapshot of origin/main's file list. Deterministic and
 * network-free (a shallow CI checkout has no origin/main ref); staleness
 * against a resolvable origin/main is enforced separately in main().
 * @returns {{ commit: string, paths: Set<string> }}
 */
let mainTreeCache = null;
export function mainTreeSnapshot() {
	if (mainTreeCache === null) {
		const raw = JSON.parse(readFileSync(join(root, MAIN_TREE_SNAPSHOT), 'utf8'));
		mainTreeCache = { commit: raw.commit, paths: new Set(raw.paths), anchors: raw.anchors || {} };
	}
	return mainTreeCache;
}

/** Whether a tree's file list contains `path` as a file or as a directory. */
export function treeContains(paths, path) {
	if (path === '') return true;
	if (paths.has(path)) return true;
	const prefix = path + '/';
	for (const candidate of paths) {
		if (candidate.startsWith(prefix)) return true;
	}
	return false;
}

/** origin/main's commit, or null when the ref is unavailable (shallow CI). */
export function resolvableMainCommit() {
	if (!gitUsable()) return null;
	try {
		return gitLines(['rev-parse', 'origin/main'])[0] ?? null;
	} catch {
		return null;
	}
}

/**
 * Whether this checkout IS the main line: the `main` branch itself (checked
 * out locally while building a promotion, or by CI's push checkout), or a
 * detached HEAD sitting exactly on the published main tip (a release-tag
 * verify). In that state the tree `blob/main` names is the very tree being
 * checked, so main links validate against the staged tree directly and the
 * snapshot comparison is moot - a snapshot recording main's own commit from
 * inside main's tree would be a SHA self-reference no commit can satisfy.
 * Branch identity comes FIRST so a promotion commit is green on a local
 * main checkout BEFORE it is pushed; commit equality alone would only turn
 * true after the push, leaving the promotion with no green state anywhere.
 * A dev checkout never satisfies either arm, so a link only main will carry
 * stays red on dev - deliberately.
 */
let onMainCache = null;
export function onMainLine() {
	if (onMainCache === null) {
		onMainCache = false;
		if (gitUsable()) {
			try {
				const branch = gitLines(['rev-parse', '--abbrev-ref', 'HEAD'])[0] ?? '';
				if (branch === 'main') {
					onMainCache = true;
				} else if (branch === 'HEAD') {
					const live = resolvableMainCommit();
					onMainCache = live !== null && (gitLines(['rev-parse', 'HEAD'])[0] ?? '') === live;
				}
			} catch {
				onMainCache = false;
			}
		}
	}
	return onMainCache;
}

const REPOSITORY_DOCS = [
	'CHANGELOG.md',
	'CONTRIBUTING.md',
	'bench',
	'docs/release-manifest.md',
	'docs/releasing.md',
	'SECURITY.md'
];

function addFilesBeneath(relative, files) {
	const absolute = join(root, relative);
	if (!existsSync(absolute)) return;
	const stat = statSync(absolute);
	if (stat.isFile()) {
		files.add(relative.split('\\').join('/'));
		return;
	}
	if (!stat.isDirectory()) return;
	for (const entry of readdirSync(absolute)) addFilesBeneath(join(relative, entry), files);
}

function trackedMarkdown() {
	try {
		const repositoryRoot = execFileSync('git', ['-C', root, 'rev-parse', '--show-toplevel'], {
			encoding: 'utf8',
			windowsHide: true,
			stdio: ['ignore', 'pipe', 'ignore']
		}).trim();
		if (resolve(repositoryRoot).toLowerCase() !== root.toLowerCase()) return [];
		return execFileSync('git', ['-C', root, 'ls-files', '-z', '--', '*.md'], {
			encoding: 'utf8',
			windowsHide: true,
			stdio: ['ignore', 'pipe', 'ignore']
		}).split('\0').filter(Boolean);
	} catch {
		return [];
	}
}

/**
 * Every Markdown document owned by this checkout or included in the package.
 * The package-file walk is also the fallback when the checker runs without a
 * Git worktree.
 *
 * @returns {string[]}
 */
export function documentationFiles() {
	const files = new Set(trackedMarkdown());
	for (const relative of REPOSITORY_DOCS) addFilesBeneath(relative, files);
	for (const relative of packageFiles()) {
		if (relative.toLowerCase().endsWith('.md')) files.add(relative);
	}
	return [...files].sort();
}

/** Every file the package allowlist includes, with exact repository casing. */
export function packageFiles() {
	const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
	const files = new Set(['package.json']);
	for (const relative of pkg.files || []) addFilesBeneath(relative, files);
	return [...files].sort();
}

const rootRealpath = realpathSync(root);

function ownedPathStatus(relativePath) {
	if (posix.isAbsolute(relativePath) || relativePath === '..' || relativePath.startsWith('../')) {
		return 'outside';
	}
	let cursor = root;
	for (const segment of relativePath.split('/').filter(Boolean)) {
		if (!existsSync(cursor) || !statSync(cursor).isDirectory()) return 'missing';
		if (!readdirSync(cursor).includes(segment)) return 'missing';
		cursor = join(cursor, segment);
	}
	if (!existsSync(cursor)) return 'missing';
	const escaped = pathRelative(rootRealpath, realpathSync(cursor));
	if (escaped === '..' || escaped.startsWith('..' + sep) || isAbsolute(escaped)) return 'outside';
	return 'owned';
}

function packageContains(relativePath, packagedFiles) {
	const target = relativePath.replace(/\/$/, '');
	if (packagedFiles.has(target)) return true;
	for (const file of packagedFiles) {
		if (file.startsWith(target + '/')) return true;
	}
	return false;
}

/**
 * GitHub's heading slug: strip inline markdown, lowercase, delete everything
 * that is not a letter, digit, space, hyphen or underscore, then turn spaces
 * into hyphens. Repeated slugs get `-1`, `-2`, ... in document order.
 *
 * @param {string} heading heading text, without the leading `#`s
 * @returns {string}
 */
function inlineText(tokens = []) {
	let result = '';
	for (const token of tokens) {
		if (token.type === 'text' || token.type === 'code_inline') result += token.content;
		else if (token.type === 'softbreak' || token.type === 'hardbreak') result += ' ';
		else if (token.type === 'image') result += inlineText(token.children || []) || token.content;
		else if (token.children) result += inlineText(token.children);
	}
	return result;
}

function renderedInlineText(source) {
	const tokens = markdown.parseInline(source, {});
	return tokens.map((token) => inlineText(token.children || [])).join('');
}

export function slugify(heading) {
	return slug(renderedInlineText(heading.replace(/[ \t]+#+[ \t]*$/, '')));
}

/**
 * Every anchor one document defines: its headings' slugs plus any explicit
 * `<a name>` / `<a id>`. Fenced code blocks are skipped, so a `# comment` line
 * inside a shell example is not read as a heading.
 *
 * @param {string} text
 * @returns {Set<string>}
 */
export function headingsOf(text) {
	const headings = [];
	const seen = new GithubSlugger();
	const tokens = markdown.parse(text, {});
	for (let index = 0; index < tokens.length; index++) {
		if (tokens[index].type !== 'heading_open' || tokens[index + 1]?.type !== 'inline') continue;
		const title = renderedInlineText(tokens[index + 1].content);
		headings.push({ title, level: Number(tokens[index].tag.slice(1)), anchor: seen.slug(title) });
	}
	return headings;
}

export function anchorsOf(text) {
	const anchors = new Set(headingsOf(text).map((heading) => heading.anchor));
	const rendered = parseFragment(markdown.render(text));
	function visit(node) {
		if (node.tagName === 'a') {
			for (const attribute of node.attrs || []) {
				if (attribute.name === 'name' || attribute.name === 'id') anchors.add(attribute.value);
			}
		}
		for (const child of node.childNodes || []) visit(child);
	}
	visit(rendered);
	return anchors;
}

/**
 * Every markdown link target in a document, with its line number. Inline code
 * spans are excluded: `[x](#y)` written as an EXAMPLE of a link is not one.
 *
 * @param {string} text
 * @returns {{ line: number, target: string }[]}
 */
export function linksOf(text) {
	const links = [];

	function htmlTargets(source, firstLine) {
		const targets = [];
		const rendered = parseFragment(source, { sourceCodeLocationInfo: true });
		function visit(node) {
			const tag = node.tagName?.toLowerCase();
			const attributeName = tag === 'a' ? 'href' : tag === 'img' ? 'src' : null;
			if (attributeName) {
				const attribute = node.attrs?.find((candidate) => candidate.name.toLowerCase() === attributeName);
				if (attribute) targets.push({
					line: firstLine + (node.sourceCodeLocation?.startLine || 1) - 1,
					target: attribute.value
				});
			}
			for (const child of node.childNodes || []) visit(child);
		}
		visit(rendered);
		return targets;
	}

	function inlineTargets(tokens, firstLine) {
		const targets = [];
		let line = firstLine;
		for (const token of tokens || []) {
			if (token.type === 'softbreak' || token.type === 'hardbreak') {
				line++;
				continue;
			}
			if (token.type === 'link_open') {
				const target = token.attrGet('href');
				if (target !== null) targets.push({ line, target });
			} else if (token.type === 'image') {
				const target = token.attrGet('src');
				if (target !== null) targets.push({ line, target });
			} else if (token.type === 'html_inline') {
				targets.push(...htmlTargets(token.content, line));
			}
		}
		return targets;
	}

	for (const token of markdown.parse(text, {})) {
		const line = (token.map?.[0] ?? 0) + 1;
		const targets = token.type === 'inline'
			? inlineTargets(token.children, line)
			: token.type === 'html_block' ? htmlTargets(token.content, line) : [];
		links.push(...targets);
	}
	return links;
}

/** Documents that exist, read once. */
function loadDocs() {
	/** @type {Map<string, { text: string, anchors: Set<string> }>} */
	const docs = new Map();
	for (const rel of documentationFiles()) {
		const abs = join(root, rel);
		if (!existsSync(abs)) continue;
		const text = readFileSync(abs, 'utf8');
		docs.set(rel, { text, anchors: anchorsOf(text) });
	}
	return docs;
}

/**
 * Resolve one link against the document it appears in.
 *
 * @param {string} rel the document containing the link
 * @param {string} target the link target as written
 * @param {Map<string, { anchors: Set<string> }>} docs
 * @param {{ packagedDocs?: Set<string>, packagedFiles?: Set<string> }} [options]
 * @returns {string | null} the failure, or null when it resolves
 */
const sourceAnchors = new Map();
function checkSourceAnchor(ref, path, target) {
	const fragment = new URL(target).hash.slice(1);
	if (!fragment || !/\.md$/i.test(path) || /^L\d+(?:-L\d+)?$/.test(fragment)) return null;
	let decoded;
	try { decoded = decodeURIComponent(fragment); } catch { return 'malformed source anchor'; }
	let anchors;
	if (ref === 'main' && !onMainLine()) {
		anchors = mainTreeSnapshot().anchors[path];
		if (!anchors) return `missing published Markdown anchor snapshot: ${path}`;
	} else {
		if (!sourceAnchors.has(path)) {
			const source = execFileSync('git', ['-C', root, 'show', ':' + path], { encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
			sourceAnchors.set(path, [...anchorsOf(source)]);
		}
		anchors = sourceAnchors.get(path);
	}
	return anchors.includes(decoded) ? null : `no source heading produces #${decoded} in ${ref}/${path}`;
}

export function checkLink(rel, target, docs, options = {}) {
	// A single-slash scheme typo (https:/example.com) parses as a relative
	// path in a browser but matches the scheme regex below, so it would be
	// waved through as external while being dead in both worlds.
	if (/^https?:\/(?!\/)/i.test(target)) {
		return `malformed scheme (single slash) in link: ${target}`;
	}
	// Same-repo GitHub source routes are validated against the tree the URL
	// NAMES, never this working directory: a file can exist here and still
	// 404 on GitHub today. `main` is the published stable tree (the checked-in
	// snapshot, so the answer is about what is public NOW, not what a future
	// promotion will make public); `dev` is this line's branch, validated
	// against the staged git index the doc itself rides.
	const sameRepo = /^https:\/\/github\.com\/lanteanio\/svelte-realtime\/(blob|tree|raw)\/([^/#?]+)(?:\/([^#?]*))?/i.exec(target);
	if (sameRepo) {
		const [, , ref, blobPath = ''] = sameRepo;
		if (ref !== 'main' && ref !== 'dev') {
			return `same-repo source link must name the published main tree or this line's dev branch, not ${ref}: ${target}`;
		}
		let decoded;
		try { decoded = decodeURIComponent(blobPath.replace(/\/+$/, '')); }
		catch { return `malformed percent escape in path: ${target}`; }
		const staged = stagedTree();
		if (staged === null) return null; // no usable git context; noted in the summary
		if (ref === 'main' && !onMainLine()) {
			if (!treeContains(mainTreeSnapshot().paths, decoded)) {
				return `same-repo source link names a path absent from the published main tree: ${target}` +
					' (content that ships with this line links blob/dev until a stable promotion; after one, regenerate the snapshot with: node scripts/check-links.js --write-main-tree)';
			}
			return checkSourceAnchor(ref, decoded, target);
		}
		// The dev line's own tree - and main's too when this checkout IS the
		// published main tip, where the snapshot would be a SHA self-reference.
		if (!treeContains(staged, decoded)) {
			return `same-repo source link names a path absent from the staged tree (the git index): ${target}`;
		}
		return checkSourceAnchor(ref, decoded, target);
	}
	if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('//')) return null; // external or mailto
	if (target.startsWith('#')) {
		let anchor;
		try { anchor = decodeURIComponent(target.slice(1)); }
		catch { return `malformed percent escape in anchor: ${target}`; }
		const doc = docs.get(rel);
		return doc && doc.anchors.has(anchor) ? null : `no heading in ${rel} produces #${anchor}`;
	}

	const hashAt = target.indexOf('#');
	const route = hashAt === -1 ? target : target.slice(0, hashAt);
	const anchor = hashAt === -1 ? undefined : target.slice(hashAt + 1);
	const queryAt = route.indexOf('?');
	const encodedPath = queryAt === -1 ? route : route.slice(0, queryAt);
	if (encodedPath === '') return null;
	let decodedPath;
	try { decodedPath = decodeURIComponent(encodedPath); }
	catch { return `malformed percent escape in path: ${encodedPath}`; }
	const resolved = posix.normalize(posix.join(posix.dirname(rel.split('\\').join('/')), decodedPath));
	const status = ownedPathStatus(resolved);
	if (status === 'outside') return `path leaves repository: ${resolved}`;
	if (status === 'missing') return `no such file with exact case: ${resolved}`;
	const staged = stagedTree();
	if (staged && !treeContains(staged, resolved)) return `target is not tracked in the git index: ${resolved}`;
	if (options.packagedDocs?.has(rel) && options.packagedFiles && !packageContains(resolved, options.packagedFiles)) {
		return `target omitted from package: ${resolved}`;
	}
	if (anchor === undefined) return null;

	// A cross-document anchor is only checkable when the target is one of the
	// documents this gate reads; anything else resolves as a plain file link.
	const doc = docs.get(resolved);
	if (!doc) return null;
	let decodedAnchor;
	try { decodedAnchor = decodeURIComponent(anchor); }
	catch { return `malformed percent escape in anchor: ${anchor}`; }
	return doc.anchors.has(decodedAnchor) ? null : `no heading in ${resolved} produces #${anchor}`;
}

function writeMainTree() {
	const commit = resolvableMainCommit();
	if (commit === null) {
		console.error('check-links --write-main-tree FAILED: origin/main is not resolvable here; fetch it first (git fetch origin main).');
		process.exit(1);
	}
	const paths = gitLines(['ls-tree', '-r', '--name-only', commit]);
	const body = {
		comment: 'File list of the published stable tree (origin/main), consumed by scripts/check-links.js to validate same-repo blob/main source links without network or a full clone. Regenerate after a stable promotion: node scripts/check-links.js --write-main-tree',
		commit,
		paths,
		anchors: Object.fromEntries(paths.filter((path) => /\.md$/i.test(path)).map((path) => [path, [...anchorsOf(execFileSync('git', ['-C', root, 'show', commit + ':' + path], { encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024 }))]]))
	};
	writeFileSync(join(root, MAIN_TREE_SNAPSHOT), JSON.stringify(body, null, '\t') + '\n');
	console.log(`check-links: wrote ${MAIN_TREE_SNAPSHOT} at origin/main ${commit.slice(0, 7)} (${paths.length} paths).`);
}

function main() {
	const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
	const docs = loadDocs();
	const packagedFiles = new Set(packageFiles());
	const packagedDocs = new Set([...packagedFiles].filter((relative) => relative.toLowerCase().endsWith('.md')));
	console.log(`check-links: ${pkg.name}@${pkg.version}`);

	// The main-tree snapshot must describe the origin/main that exists, or
	// blob/main validation is answering for a tree nobody is looking at. A
	// shallow checkout without the ref cannot make that comparison; every
	// local clone can and does, so staleness cannot survive a release cycle.
	// On the published main tip itself the comparison is skipped: main links
	// validate against this very tree there, and a snapshot recording main's
	// own commit from inside main's tree cannot exist.
	if (!gitUsable()) {
		console.log('  no usable git context: same-repo source routes unchecked here (repo clones and CI validate them).');
	} else if (onMainLine()) {
		console.log('  this checkout is the published main tip: blob/main validates against the staged tree.');
	} else {
		const snapshot = mainTreeSnapshot();
		const liveMain = resolvableMainCommit();
		if (liveMain !== null && liveMain !== snapshot.commit) {
			console.error(`check-links FAILED: ${MAIN_TREE_SNAPSHOT} records origin/main ${snapshot.commit.slice(0, 7)} but origin/main is ${liveMain.slice(0, 7)}.`);
			console.error('  Regenerate it with: node scripts/check-links.js --write-main-tree');
			process.exit(1);
		}
		console.log(`  main tree snapshot @${snapshot.commit.slice(0, 7)} (${snapshot.paths.size} paths, ${liveMain === null ? 'origin/main unavailable here - drift-checked on full clones' : 'matches origin/main'}).`);
	}

	let total = 0;
	const broken = [];
	for (const [rel, doc] of docs) {
		for (const { line, target } of linksOf(doc.text)) {
			total++;
			const failure = checkLink(rel, target, docs, { packagedDocs, packagedFiles });
			if (failure) broken.push({ rel, line, target, failure });
			else if (verbose) console.log(`  ok ${rel}:${line} -> ${target}`);
		}
	}

	const headings = [...docs.values()].reduce((n, d) => n + d.anchors.size, 0);
	console.log(`  ${docs.size} document(s), ${packagedDocs.size} packaged, ${headings} anchor(s), ${total} internal link(s) checked.`);

	if (broken.length) {
		console.error(`\ncheck-links FAILED (${broken.length} dead link(s)):`);
		for (const b of broken) console.error(`  x ${b.rel}:${b.line}  ${b.target}  - ${b.failure}`);
		console.error(`  Fix the link or the heading it points at. External links are not fetched.`);
		process.exit(1);
	}

	console.log(`  OK - every internal link resolves.`);
}

// Importable for its own test suite; only the CLI invocation reads the docs.
if (isScriptEntry(import.meta.url)) {
	if (process.argv.includes('--write-main-tree')) writeMainTree();
	else main();
}
