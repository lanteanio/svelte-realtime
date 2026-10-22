import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const PACKAGE = 'svelte-adapter-uws-extensions';
const root = fileURLToPath(new URL('..', import.meta.url));
// The package exports no ./package.json; walk up from a resolved subpath to its root.
let extensionsDir = dirname(createRequire(import.meta.url).resolve(PACKAGE + '/breaker'));
while (!existsSync(join(extensionsDir, 'package.json'))) extensionsDir = dirname(extensionsDir);
const extensionsExports = JSON.parse(readFileSync(join(extensionsDir, 'package.json'), 'utf8')).exports;
const TEXT = new Set(['.js', '.mjs', '.cjs', '.ts', '.md', '.svelte']);

// Every import or export statement that names an extensions module, in any of
// the forms a reader can copy: named, type-only, default, namespace, mixed,
// re-export and dynamic import. JSDoc continuation stars are stripped before parsing.
const STATEMENT = new RegExp(String.raw`\b(?:import|export)\s+(type\s+)?([^;'"\x60]*?)\s*\bfrom\s*(['"])(${PACKAGE}(?:/[^'"]*)?)\3|\bimport\s*\(\s*(['"])(${PACKAGE}(?:/[^'"]*)?)\5\s*\)`, 'g');
const QUOTED = new RegExp(String.raw`(['"])(${PACKAGE}[^'"]*)\1`, 'g');
// A subpath mention outside a URL; one ending in .js or .ts names a file inside the package.
const SUBPATH = new RegExp(String.raw`(?<![\w/.-])${PACKAGE}(/[A-Za-z0-9_./-]*[A-Za-z0-9_-])`, 'g');
// Release history keeps the module names of its time; it is not copied as current code.
const HISTORY = new Set(['CHANGELOG.md']);

function parseClause(raw) {
	const clause = raw.replace(/\n\s*\*\s?/g, ' ').trim();
	const names = [];
	let rest = clause;
	const named = /\{([^}]*)\}/.exec(rest);
	if (named) {
		for (const item of named[1].split(',').map(part => part.trim()).filter(Boolean)) {
			const match = /^(type\s+)?([A-Za-z_$][\w$]*)(?:\s+as\s+[A-Za-z_$][\w$]*)?$/.exec(item);
			if (!match) return null;
			names.push({ name: match[2], type: !!match[1] });
		}
		rest = (rest.slice(0, named.index) + rest.slice(named.index + named[0].length)).trim();
	}
	for (const part of rest.split(',').map(item => item.trim()).filter(Boolean)) {
		if (/^\*\s+as\s+[A-Za-z_$][\w$]*$/.test(part)) continue;
		if (/^[A-Za-z_$][\w$]*$/.test(part)) { names.push({ name: 'default', type: false }); continue; }
		return null;
	}
	return named || rest ? names : null;
}

function scanFile(file, text) {
	const statements = [];
	const covered = new Set();
	const problems = [];
	const line = (index) => text.slice(0, index).split('\n').length;
	for (const match of text.matchAll(STATEMENT)) {
		const specifier = match[4] ?? match[6];
		covered.add(match.index + match[0].lastIndexOf(specifier) - 1);
		if (match[6]) { statements.push({ file, line: line(match.index), specifier, names: [] }); continue; }
		const names = parseClause(match[2]);
		if (!names) { problems.push(`${file}:${line(match.index)} has an import clause this check cannot read: ${match[0]}`); continue; }
		statements.push({ file, line: line(match.index), specifier, names: names.map(item => ({ ...item, type: item.type || !!match[1] })) });
	}
	for (const match of text.matchAll(QUOTED)) {
		// An install spec such as name@1.2.3 is a dependency, not an import.
		if (covered.has(match.index) || /^[^/]*@[0-9]/.test(match[2])) continue;
		problems.push(`${file}:${line(match.index)} quotes ${match[2]} outside an import form this check can read`);
	}
	const subpaths = [...text.matchAll(SUBPATH)].map(match => ({ file, line: line(match.index), subpath: '.' + match[1] }));
	return { statements, problems, subpaths };
}

function declaresType(subpath, name) {
	const types = extensionsExports[subpath]?.types;
	if (!types) return false;
	const source = readFileSync(join(extensionsDir, types), 'utf8');
	return new RegExp(String.raw`\bexport\s+(?:declare\s+)?(?:interface|type|class|function|const|let|var|enum|namespace)\s+${name}\b|\bexport\s*\{[^}]*\b${name}\b[^}]*\}`).test(source);
}

let temp, packedRoot, packedFiles;
beforeAll(() => {
	// Scan the files npm actually ships, extracted from a real tarball.
	temp = mkdtempSync(join(tmpdir(), 'realtime-extension-imports-'));
	const npm = process.env.npm_execpath || join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
	const [packed] = JSON.parse(execFileSync(process.execPath, [npm, 'pack', '--json', '--ignore-scripts', '--pack-destination', temp], { cwd: root, encoding: 'utf8', timeout: 120000 }));
	packedRoot = join(temp, 'package');
	mkdirSync(packedRoot);
	execFileSync('tar', ['-xzf', packed.filename, '-C', 'package', '--strip-components=1'], { cwd: temp, timeout: 120000 });
	packedFiles = packed.files.map(entry => entry.path).filter(path => TEXT.has(extname(path)) && !HISTORY.has(path));
}, 180000);
afterAll(() => { if (temp) rmSync(temp, { recursive: true, force: true }); });

describe('documented extension imports', () => {
	it('scans every shipped source, declaration and document', () => {
		for (const path of ['README.md', 'MIGRATION.md', 'src/server.js', 'src/server.d.ts', 'src/server/push.js', 'src/server/cron-engine.js']) {
			expect(packedFiles).toContain(path);
		}
		expect(packedFiles.some(path => path.startsWith('docs/') && path.endsWith('.md'))).toBe(true);
	});

	it('resolves every documented extension import and subpath through the installed package exports', async () => {
		const problems = [];
		let checked = 0;
		for (const path of packedFiles) {
			const scan = scanFile(path, readFileSync(join(packedRoot, path), 'utf8'));
			problems.push(...scan.problems);
			for (const { file, line, subpath } of scan.subpaths) {
				const found = /\.(?:js|ts)$/.test(subpath) ? existsSync(join(extensionsDir, 'src', subpath)) : subpath in extensionsExports;
				if (!found) problems.push(`${file}:${line} names ${PACKAGE}${subpath.slice(1)}, which the package does not ${/\.(?:js|ts)$/.test(subpath) ? 'contain' : 'export'}`);
			}
			for (const { file, line, specifier, names } of scan.statements) {
				const subpath = '.' + specifier.slice(PACKAGE.length);
				if (!(subpath in extensionsExports)) {
					problems.push(`${file}:${line} imports ${specifier}, which the package does not export`);
					continue;
				}
				const runtime = await import(/* @vite-ignore */ specifier);
				for (const { name, type } of names) {
					checked++;
					if (!(type ? declaresType(subpath, name) : name in runtime)) problems.push(`${file}:${line} imports ${name} from ${specifier}, which does not export it`);
				}
			}
		}
		expect(problems).toEqual([]);
		expect(checked).toBeGreaterThan(20);
	}, 60000);
});

describe('extension import scanner', () => {
	it('reads every import form and refuses the ones it cannot', () => {
		const text = [
			`import { a, b as c, type T } from '${PACKAGE}/redis';`,
			`import type { U } from '${PACKAGE}/redis';`,
			`import Default, { d } from "${PACKAGE}/postgres";`,
			`import * as ns from '${PACKAGE}/breaker';`,
			`export { e } from '${PACKAGE}/redis';`,
			` * import {\n *   f,\n *   g\n * } from '${PACKAGE}/redis/leader';`,
			`const lazy = await import('${PACKAGE}/redis/lock');`,
			`// or: from '${PACKAGE}/postgres/alarm-store'`,
			`const spec = '${PACKAGE}@1.2.3';`,
			`See \`${PACKAGE}/redis/missing\` for details.`,
			`import { a b } from '${PACKAGE}/redis';`
		].join('\n');
		const scan = scanFile('fixture.js', text);
		expect(scan.statements.map(s => [s.specifier, s.names.map(n => (n.type ? 'type ' : '') + n.name).join(',')])).toEqual([
			[PACKAGE + '/redis', 'a,b,type T'],
			[PACKAGE + '/redis', 'type U'],
			[PACKAGE + '/postgres', 'd,default'],
			[PACKAGE + '/breaker', ''],
			[PACKAGE + '/redis', 'e'],
			[PACKAGE + '/redis/leader', 'f,g'],
			[PACKAGE + '/redis/lock', '']
		]);
		expect(scan.problems).toEqual([
			`fixture.js:14 has an import clause this check cannot read: import { a b } from '${PACKAGE}/redis'`,
			`fixture.js:11 quotes ${PACKAGE}/postgres/alarm-store outside an import form this check can read`
		]);
		expect(scan.subpaths.map(s => s.subpath)).toContain('./redis/missing');
		expect(scanFile('url.md', `https://github.com/lanteanio/${PACKAGE}/blob/dev/src/redis/pubsub.js`).subpaths).toEqual([]);
	});
});
