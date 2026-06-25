#!/usr/bin/env node
/**
 * Guard that every `svti.me/<slug>` short link referenced in the published
 * surface (src/, README.md, MIGRATION.md) is a REGISTERED slug listed in
 * scripts/known-slugs.txt. A referenced-but-unregistered slug FAILS the build,
 * so a new short link cannot ship as a dead redirect - adding the link forces a
 * known-slugs.txt entry, which is the prompt to create the redirect at svti.me
 * before release. It also catches a typo'd slug (a reference no allow-list entry
 * backs).
 *
 * Dependency-free (no eslint), modeled on the sibling check-determinism /
 * check-types scripts, wired into pretest. A slug listed in known-slugs.txt but
 * never referenced is reported as an unused entry (a note, not a failure - the
 * slug may be linked only from the docs site or held in reserve).
 *
 * Flags:
 *   --verbose  list every reference site, not just the first few per slug.
 *
 * @module scripts/check-slugs
 */
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { dirname, resolve, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const verbose = process.argv.includes('--verbose');

// Published doc surfaces: the src tree plus the two shipped markdown docs.
// (package.json `files` ships exactly src, README.md, MIGRATION.md.)
const SRC_ROOT = 'src';
const EXTRA_FILES = ['README.md', 'MIGRATION.md'];

// Path segments that are never published runtime/doc source.
const SKIP_SEGMENTS = new Set([
	'node_modules', 'test', 'tests', '__tests__', 'bench', 'benchmarks', 'scripts',
	'fixture', 'fixtures', '.svelte-kit', 'dist', 'build', 'coverage', 'examples',
	'example', 'docs', '.git'
]);

// First path segment after the host: a `#anchor` or `/subpath` is not part of
// the slug (svti.me/smooth#hit-detection registers as `smooth`).
const SLUG_RE = /svti\.me\/([a-zA-Z0-9_-]+)/g;

/** Recursively collect scannable files under `dir` (root-relative, slash paths). */
function walk(dir, out) {
	for (const name of readdirSync(dir)) {
		if (SKIP_SEGMENTS.has(name)) continue;
		const abs = join(dir, name);
		if (statSync(abs).isDirectory()) walk(abs, out);
		else out.push(relative(root, abs).split(/[\\/]/).join('/'));
	}
}

/** Load the registered-slug allow-list (blank + `#` lines ignored). */
function loadKnown() {
	const text = readFileSync(join(root, 'scripts', 'known-slugs.txt'), 'utf8');
	const set = new Set();
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.trim();
		if (line === '' || line.startsWith('#')) continue;
		set.add(line);
	}
	return set;
}

/** Every svti.me reference in one file: { rel, line, slug }. */
function scanFile(rel) {
	const refs = [];
	const lines = readFileSync(join(root, rel), 'utf8').split(/\r?\n/);
	for (let i = 0; i < lines.length; i++) {
		SLUG_RE.lastIndex = 0;
		let m;
		while ((m = SLUG_RE.exec(lines[i])) !== null) refs.push({ rel, line: i + 1, slug: m[1] });
	}
	return refs;
}

const files = [];
walk(join(root, SRC_ROOT), files);
for (const f of EXTRA_FILES) if (existsSync(join(root, f))) files.push(f);
files.sort();

const refs = [];
for (const rel of files) refs.push(...scanFile(rel));

const known = loadKnown();
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
console.log(`check-slugs: ${pkg.name}@${pkg.version}`);
console.log(`  ${files.length} file(s) scanned, ${refs.length} svti.me reference(s), ${known.size} registered slug(s).`);

const referenced = new Set(refs.map((r) => r.slug));

// Unused: registered but never referenced -> note only (do not fail).
const unused = [...known].filter((s) => !referenced.has(s)).sort();
if (unused.length) {
	console.log(`  note (registered but unreferenced in src/README/MIGRATION; keep or prune): ${unused.join(', ')}`);
}

// Unregistered: a referenced slug missing from the allow-list -> FAIL.
const unregistered = [...referenced].filter((s) => !known.has(s)).sort();
if (unregistered.length) {
	console.error(`\ncheck-slugs FAILED (${unregistered.length} unregistered slug(s)):`);
	for (const slug of unregistered) {
		const sites = refs.filter((r) => r.slug === slug);
		console.error(`  x svti.me/${slug}  (${sites.length} reference(s))`);
		const show = verbose ? sites : sites.slice(0, 3);
		for (const s of show) console.error(`      ${s.rel}:${s.line}`);
		if (!verbose && sites.length > 3) console.error(`      ... +${sites.length - 3} more (--verbose)`);
	}
	console.error(`  Add the slug to scripts/known-slugs.txt AND create the redirect at svti.me, or fix the typo.`);
	process.exit(1);
}

console.log(`  OK - every referenced slug is registered.`);
