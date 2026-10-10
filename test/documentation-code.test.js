import { describe, expect, it } from 'vitest';
import { buildManifest, classifyBlock, inventoryMarkdown, packageImportProblems, memberSurfaceProblems, syntaxProblem, validateManifest } from '../scripts/check-doc-code.js';
const block = (language, content) => inventoryMarkdown('```' + language + '\n' + content + '\n```')[0];

describe('README example verification', () => {
	it('keys examples by content and accepts surrounding prose edits', () => {
		const original = { 'README.md': '# Guide\n```js\nconsole.log(1);\n```\n' };
		const manifest = buildManifest(original);
		expect(validateManifest(manifest, { 'README.md': '# Guide\nNew prose.\n\n```js\nconsole.log(1);\n```\n' })).toEqual([]);
		expect(validateManifest(manifest, { 'README.md': original['README.md'].replace('log(1)', 'log(2)') }).join('\n')).toContain('unclassified');
	});
	it('fails unmarked invalid syntax and requires explicit fragment ceiling growth', () => {
		expect(() => buildManifest({ 'README.md': '```js\nreturn value;\n```' })).toThrow('cannot classify');
		const source = '<!-- doc-code: fragment reason="Function body excerpt." -->\n```js\nreturn value;\n```';
		expect(() => buildManifest({ 'README.md': source }, { previousManifest: { fragmentCeiling: 0 } })).toThrow('exceeds the pinned ceiling');
	});
	it('compiles Svelte components without claiming they run in Node', () => {
		expect(classifyBlock(block('svelte', '<script>let count = 0;</script><button onclick={() => count++}>{count}</button>')).record).toMatchObject({ classification: 'syntax', reason: 'not runnable: browser-component' });
		expect(syntaxProblem(block('svelte', '{#if true}<p>broken'))).not.toBeNull();
	});
	it('detects nonexistent package exports and helpers in tutorial context', () => {
		const example = block('js', "import { live, missingHelper } from 'svelte-realtime/server'; import { db } from '$lib/server/db'; live.nonexistentHelper(db);");
		expect(classifyBlock(example).record.classification).toBe('tutorial');
		expect(packageImportProblems(example).join('\n')).toContain('no declared export missingHelper');
		expect(memberSurfaceProblems(example).join('\n')).toContain('nonexistentHelper');
	});
	it('retains type-only external imports as application context', () => {
		const result = classifyBlock(block('ts', "import type { AppConfig } from '$lib/config'; const options: AppConfig = {}; export default options;"));
		expect(result.record).toMatchObject({ classification: 'tutorial', channel: 'app-context' });
	});
});
