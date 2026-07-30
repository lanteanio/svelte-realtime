#!/usr/bin/env node
/**
 * Validate that the package's public surface is intact.
 *
 * For every subpath in the `exports` map (and the top-level
 * `types`/`main`/`module` fields) this asserts that:
 *   1. the target file exists on disk;
 *   2. a `types`/`typings` condition points at a real `.d.ts`;
 *   3. the target is covered by the `files` publish allowlist, so it actually
 *      ships (a file that resolves locally but is missing from `files` 404s
 *      after publish).
 *
 * It guards the drift class where an `exports` entry points at a missing or
 * mistyped declaration (silently degrading consumers to `any`) or a file that
 * never gets published.
 *
 * It then TYPECHECKS the shipped declarations, with `skipLibCheck` OFF. The
 * resolve-and-ship checks above cannot see an error INSIDE a `.d.ts`, and
 * `skipLibCheck: true` is the SvelteKit/TS project default, so a declaration
 * file that does not compile against itself is invisible to us and to most
 * consumers - while anyone who typechecks library types sees that surface as
 * broken. (This is exactly how a `UploadContext extends LiveContext` member
 * collision shipped.)
 *
 * The structural checks stay dependency-free so they run anywhere `node` does.
 * The typecheck rung needs TypeScript; when it is not installed the rung SKIPS
 * with a notice rather than failing, so a clean install without the devDependency
 * still passes `npm run check`. Add `typescript` to devDependencies to make it
 * enforcing. Run via `npm run check`; wired into `pretest`.
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

const errors = [];
const checked = [];

const TYPE_CONDITIONS = new Set(['types', 'typings']);
const filesHasGlob = Array.isArray(pkg.files) && pkg.files.some((e) => /[*?{}[\]!]/.test(e));

function exists(rel) {
	return existsSync(join(root, rel.replace(/^\.\//, '')));
}

// True when a target is included by the `files` allowlist. Skipped (treated as
// covered) when there is no allowlist or it uses globs we will not try to model.
function isPublished(target) {
	if (!Array.isArray(pkg.files) || filesHasGlob) return true;
	const norm = target.replace(/^\.\//, '');
	return pkg.files.some((entry) => {
		const e = entry.replace(/^\.\//, '').replace(/\/$/, '');
		return norm === e || norm.startsWith(e + '/');
	});
}

function checkTarget(label, condition, target) {
	if (typeof target !== 'string') return;
	const ok = exists(target);
	checked.push({ label, condition, target, ok });
	if (!ok) {
		errors.push(`${label} (${condition}): target does not exist -> ${target}`);
		return;
	}
	if (TYPE_CONDITIONS.has(condition) && !target.endsWith('.d.ts')) {
		errors.push(`${label} (${condition}): a type condition must point at a .d.ts -> ${target}`);
	}
	if (!isPublished(target)) {
		errors.push(`${label} (${condition}): resolves locally but is not in the "files" publish allowlist -> ${target}`);
	}
}

// An exports value object is a conditions map when no key starts with '.'; a
// key starting with '.' marks a nested subpath. Walk handles both, plus the
// string shorthand and conditions nested under conditions.
function isConditions(obj) {
	return Object.keys(obj).every((k) => !k.startsWith('.'));
}

function walk(subpath, value) {
	if (typeof value === 'string') {
		checkTarget(subpath, 'default', value);
		return;
	}
	if (!value || typeof value !== 'object') return;
	if (isConditions(value)) {
		for (const [condition, target] of Object.entries(value)) {
			if (typeof target === 'string') checkTarget(subpath, condition, target);
			else walk(subpath, target);
		}
	} else {
		for (const [seg, sub] of Object.entries(value)) {
			walk(subpath === '.' ? seg : subpath + seg.replace(/^\./, ''), sub);
		}
	}
}

if (pkg.exports && typeof pkg.exports === 'object') {
	for (const [subpath, value] of Object.entries(pkg.exports)) walk(subpath, value);
} else if (typeof pkg.exports === 'string') {
	checkTarget('.', 'default', pkg.exports);
}

for (const field of ['types', 'typings']) {
	if (typeof pkg[field] === 'string') checkTarget(`(package.${field})`, 'types', pkg[field]);
}
for (const field of ['main', 'module']) {
	if (typeof pkg[field] === 'string') checkTarget(`(package.${field})`, 'default', pkg[field]);
}

const declarations = checked.filter((c) => TYPE_CONDITIONS.has(c.condition));
console.log(`check-types: ${pkg.name}@${pkg.version}`);
console.log(`  ${checked.length} export target(s) checked, ${declarations.length} declaration file(s).`);

// Typecheck rung: compile every shipped declaration with skipLibCheck OFF, so an
// error INSIDE a .d.ts (a member collision, a broken extends, a dangling import)
// fails here instead of only for the consumers who happen to check lib types.
let ts = null;
try {
	ts = (await import('typescript')).default;
} catch {
	console.log('  ~ typecheck SKIPPED: typescript is not installed (add it to devDependencies to enforce).');
}

if (ts) {
	const files = [...new Set(declarations.map((d) => resolve(root, d.target)))].filter((f) => existsSync(f));
	const program = ts.createProgram(files, {
		noEmit: true,
		strict: true,
		skipLibCheck: false,
		skipDefaultLibCheck: false,
		target: ts.ScriptTarget.ES2022,
		module: ts.ModuleKind.ESNext,
		moduleResolution: ts.ModuleResolutionKind.Bundler
	});
	// Only OUR declarations: a consumer's node_modules typing problem is not this
	// package's gate to fail on.
	const own = new Set(files.map((f) => f.replace(/\\/g, '/')));
	const diagnostics = ts.getPreEmitDiagnostics(program)
		.filter((d) => d.file && own.has(d.file.fileName.replace(/\\/g, '/')));

	if (diagnostics.length) {
		console.error(`\ncheck-types FAILED: ${diagnostics.length} type error(s) in shipped declarations:`);
		for (const d of diagnostics) {
			const { line, character } = d.file.getLineAndCharacterOfPosition(d.start ?? 0);
			const rel = d.file.fileName.replace(root.replace(/\\/g, '/'), '').replace(/^[/\\]/, '');
			console.error(`  x ${rel}(${line + 1},${character + 1}): TS${d.code}: ${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`);
		}
		process.exit(1);
	}
	console.log(`  ${files.length} declaration file(s) typecheck clean (strict, skipLibCheck off).`);
}

if (errors.length) {
	console.error(`\ncheck-types FAILED (${errors.length} problem(s)):`);
	for (const e of errors) console.error(`  x ${e}`);
	process.exit(1);
}

console.log('  OK - every exports target resolves, types are .d.ts, and all ship.');
