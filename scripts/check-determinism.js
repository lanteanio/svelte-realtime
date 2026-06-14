#!/usr/bin/env node
/**
 * Guard that framework source reads the clock, RNG and timers through the
 * injectable runtime module (runtime.js) rather than the raw native primitives.
 * Routing every nondeterministic primitive through one swappable module is what
 * lets a seeded harness replay behavior exactly; a raw call left anywhere is a
 * silent hole that makes a replay diverge.
 *
 * Dependency-free (no eslint), modeled on the adapter/extensions check scripts,
 * wired into pretest.
 *
 * Modes:
 *   - default: WARN. Prints a per-file summary of raw call sites and exits 0, so
 *     the guard can land before every call site is routed through the module.
 *   - a file listed in ENFORCED must be clean: a raw call in it FAILS (exit 1).
 *     ENFORCED grows as each area is migrated, turning the warning into a
 *     ratchet that cannot regress.
 *   - `--strict`: treat every finding as an error (the end state, once the whole
 *     surface is migrated).
 *   - `--verbose`: list every finding, not just per-file counts.
 *
 * A single line may opt out with a trailing `// determinism-allow: <reason>`
 * comment (for the genuinely cosmetic init-time log timers and the like).
 *
 * @module scripts/check-determinism
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve, join, relative, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const strict = process.argv.includes('--strict');
const verbose = process.argv.includes('--verbose');

// The only files permitted to touch the native primitives: the runtime module
// is the single binding point. Matched by basename so the per-repo path (files/
// vs shared/) does not matter.
const ALLOW_FILES = new Set(['runtime.js', 'client-runtime.js']);

// All shipped framework runtime source lives under src/. Every file there MUST
// stay clean (a raw primitive reappearing fails the build), so modules extracted
// during a decomposition are enforced automatically and cannot silently regress.
// WARN_EXEMPT lists the published entries that are NOT part of the replayable
// runtime: the scaffolder CLI (its only flagged primitive sits inside a generated
// scaffold template, not runtime code) and the public test-authoring helper
// (test-harness timing). These warn rather than fail. A single runtime line may
// still opt out with a trailing `// determinism-allow: <reason>` comment.
const SRC_ROOT = 'src';
const WARN_EXEMPT = new Set(['cli.js', 'test.js']);
function isEnforced(rel) {
	const norm = rel.split(/[\\/]/).join('/');
	if (norm !== SRC_ROOT && !norm.startsWith(SRC_ROOT + '/')) return false;
	if (WARN_EXEMPT.has(basename(rel))) return false;
	return true;
}

// Path segments that are never framework runtime source.
const SKIP_SEGMENTS = new Set([
	'node_modules', 'test', 'tests', '__tests__', 'bench', 'benchmarks', 'scripts',
	'fixture', 'fixtures', '.svelte-kit', 'dist', 'build', 'coverage', 'examples',
	'example', 'docs', '.git'
]);
const SKIP_SUFFIX = ['.test.js', '.spec.js', '.config.js', '.config.mjs', '.d.ts'];

// Ordered most-specific-first so a dotted form wins over the bare form on the
// same line (we report one primitive per line).
const PATTERNS = [
	['Date.now', /\bDate\s*\.\s*now\s*\(/],
	['new Date', /\bnew\s+Date\s*\(/],
	['performance.now', /\bperformance\s*\.\s*now\s*\(/],
	['Math.random', /\bMath\s*\.\s*random\s*\(/],
	['crypto.randomUUID', /\bcrypto\s*\.\s*randomUUID\s*\(/],
	['crypto.randomBytes', /\bcrypto\s*\.\s*randomBytes\s*\(/],
	['crypto.randomInt', /\bcrypto\s*\.\s*randomInt\s*\(/],
	['getRandomValues', /\bgetRandomValues\s*\(/],
	['randomUUID', /\brandomUUID\s*\(/],
	['randomBytes', /\brandomBytes\s*\(/],
	['randomInt', /\brandomInt\s*\(/],
	['setTimeout', /\bsetTimeout\s*\(/],
	['setInterval', /\bsetInterval\s*\(/],
	['setImmediate', /\bsetImmediate\s*\(/],
	['clearTimeout', /\bclearTimeout\s*\(/],
	['clearInterval', /\bclearInterval\s*\(/],
	['queueMicrotask', /\bqueueMicrotask\s*\(/]
];

function shouldSkipPath(rel) {
	const segs = rel.split(/[\\/]/);
	if (segs.some((s) => SKIP_SEGMENTS.has(s))) return true;
	if (SKIP_SUFFIX.some((suf) => rel.endsWith(suf))) return true;
	if (ALLOW_FILES.has(basename(rel))) return true;
	return false;
}

function walk(dir, out) {
	for (const entry of readdirSync(dir)) {
		const abs = join(dir, entry);
		let st;
		try { st = statSync(abs); } catch { continue; }
		const rel = relative(root, abs);
		if (st.isDirectory()) {
			if (SKIP_SEGMENTS.has(entry)) continue;
			walk(abs, out);
		} else if ((abs.endsWith('.js') || abs.endsWith('.mjs')) && !shouldSkipPath(rel)) {
			out.push(rel);
		}
	}
}

function scanFile(rel) {
	const findings = [];
	const text = readFileSync(join(root, rel), 'utf8');
	const lines = text.split(/\r?\n/);
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const trimmed = line.trimStart();
		if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue; // comment line
		if (line.includes('determinism-allow:')) continue; // explicit opt-out
		for (const [name, re] of PATTERNS) {
			if (re.test(line)) {
				findings.push({ rel, line: i + 1, primitive: name, snippet: trimmed.slice(0, 80) });
				break; // one primitive per line keeps the report readable
			}
		}
	}
	return findings;
}

const files = [];
walk(root, files);
files.sort();

const all = [];
for (const rel of files) all.push(...scanFile(rel));

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
console.log(`check-determinism: ${pkg.name}@${pkg.version}`);
console.log(`  ${files.length} framework source file(s) scanned, ${all.length} raw native-primitive call site(s) found.`);

const errors = all.filter((f) => strict || isEnforced(f.rel));
const warnings = all.filter((f) => !errors.includes(f));

// Per-file summary so pretest output stays bounded; --verbose lists each site.
const byFile = new Map();
for (const f of warnings) byFile.set(f.rel, (byFile.get(f.rel) || 0) + 1);
if (byFile.size) {
	console.log(`  warn (route these through runtime.js as their area is migrated):`);
	for (const [rel, n] of [...byFile.entries()].sort()) {
		console.log(`    ~ ${rel}: ${n}`);
		if (verbose) for (const f of warnings.filter((w) => w.rel === rel)) {
			console.log(`        ${f.line}: ${f.primitive}  ${f.snippet}`);
		}
	}
}

if (errors.length) {
	console.error(`\ncheck-determinism FAILED (${errors.length} enforced violation(s)):`);
	for (const f of errors) console.error(`  x ${f.rel}:${f.line}  ${f.primitive}  ${f.snippet}`);
	console.error(`  Route these through runtime.js, or annotate the line with "// determinism-allow: <reason>".`);
	process.exit(1);
}

console.log(`  OK - no enforced violations${strict ? '' : ' (warn mode)'}.`);
