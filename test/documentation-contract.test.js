import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { PATHS_START, PATHS_END, renderPaths, renderTopics, renderExports, validateManifest, validateReadme } from '../scripts/check-documentation-contract.js';
import { headingsOf, linksOf } from '../scripts/check-links.js';
const manifest = JSON.parse(readFileSync(new URL('../docs/documentation.v1.json', import.meta.url), 'utf8'));
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8').replace(/\r\n/g, '\n');

it('indexes every second-level heading and every public import', () => {
	const targets = new Set(linksOf(renderTopics(readme)).map((link) => link.target));
	for (const heading of headingsOf(readme).filter((heading) => heading.level === 2 && heading.title !== 'Table of contents')) {
		expect(targets.has('#' + heading.anchor), heading.title).toBe(true);
	}
	const exports = renderExports(pkg);
	for (const subpath of Object.keys(pkg.exports)) expect(exports).toContain('`' + (subpath === '.' ? pkg.name : pkg.name + subpath.slice(1)) + '`');
	expect(readFileSync(new URL('../docs/package-exports.md', import.meta.url), 'utf8').replace(/\r\n/g, '\n')).toBe(exports);
});

it('rejects a missing topic and exposes newly added headings', () => {
	expect(validateReadme(readme.replace('[Merge strategies](#merge-strategies)', ''), manifest).join('\n')).toContain('topic index differs');
	const expanded = readme + '\n## New capability\n';
	expect(validateReadme(expanded, { ...manifest, readmeMaxLines: expanded.split('\n').length }).join('\n')).toContain('topic index differs');
	expect(renderTopics(expanded)).toContain('[New capability](#new-capability)');
});

it('preserves rendered duplicate heading slugs and ignores fenced headings', () => {
	const rendered = renderTopics('## A & B\n## A & B\n## A--B-1\n## A & B\n```md\n## Hidden\n```\n');
	expect(linksOf(rendered).map((link) => link.target).slice(0, 4)).toEqual(['#a--b', '#a--b-1', '#a--b-1-1', '#a--b-2']);
	expect(rendered).not.toContain('Hidden');
});

it('packages release history and keeps new exports visible', () => {
	expect(pkg.files).toContain('CHANGELOG.md');
	expect(renderExports({ ...pkg, exports: { ...pkg.exports, './added': { default: './src/added.js', types: './src/added.d.ts' } } })).toContain('`svelte-realtime/added`');
	expect(() => renderExports({ ...pkg, exports: { './missing': { default: './src/missing.js' } } })).toThrow('runtime and type targets');
});

it('pins the README ratchet at its actual size with no headroom', () => {
	expect(manifest.readmeMaxLines).toBe(readme.split('\n').length);
	expect(validateReadme(readme, manifest)).toEqual([]);
	expect(validateReadme(readme + '\n', manifest).join('\n')).toContain('size ratchet');
});
it('rejects raising the README and its size limit together without an accepted growth record', () => {
	const expanded = readme + '\n\n';
	const raised = { ...manifest, readmeMaxLines: expanded.split('\n').length };
	expect(validateReadme(expanded, raised, manifest).join('\n')).toContain('accepted README growth record');
});
it('enforces routing placement independently of total README size', () => {
	const delayed = '\n'.repeat(manifest.entryBudgetLines) + readme;
	expect(validateReadme(delayed, { ...manifest, readmeMaxLines: delayed.split('\n').length }).join('\n')).toContain('entry budget');
});
it('rejects stale routing, missing anchors, duplicate destinations and changed owners', () => {
	expect(validateReadme(readme.replace('**Choose a documentation path:**', '**Stale routes:**'), manifest).join('\n')).toContain('routing block differs');
	const copy = structuredClone(manifest);
	copy.paths[0].destination = '#missing';
	const start = readme.indexOf(PATHS_START);
	const end = readme.indexOf(PATHS_END) + PATHS_END.length;
	const updated = readme.slice(0, start) + renderPaths(copy) + readme.slice(end);
	expect(validateReadme(updated, copy).join('\n')).toContain('missing local destination');
	copy.paths[1].destination = copy.paths[0].destination;
	copy.paths[0].owner = 'svelte-realtime.dev';
	expect(validateManifest(copy, pkg).join('\n')).toContain('duplicate destination');
	expect(validateManifest(copy, pkg).join('\n')).toContain('owned by a README anchor');
});
it('rejects credentialed, foreign and noncanonical site routes', () => {
	for (const destination of ['https://user@svelte-realtime.dev/tutorial', 'https://example.com/tutorial', 'https://svelte-realtime.dev/tutorial?q=1', 'https://svelte-realtime.dev/docs/../tutorial']) {
		const copy = structuredClone(manifest);
		copy.paths[3].destination = destination;
		expect(validateManifest(copy, pkg).join('\n')).toContain('clean HTTPS');
	}
});
it('keeps compatibility commands generated and native versions in one block', () => {
	expect(validateReadme(readme.replace('npm install -D ws', 'npm install -D missing'), manifest).join('\n')).toContain('compatibility block differs');
	expect(validateReadme(readme + '\nuWebSockets.js v20.69.0\n', { ...manifest, readmeMaxLines: manifest.readmeMaxLines + 2 }).join('\n')).toContain('native version facts');
});

it('rejects Markdown and bare-URL injection in route labels and needs', () => {
	for (const field of ['label', 'need']) {
		for (const value of ['Injected](https://example.com) [Tutorial', '[foreign](https://example.com)', 'https://example.com', 'escaped\\] label']) {
			const copy = structuredClone(manifest);
			copy.paths[3][field] = value;
			expect(validateManifest(copy, pkg).join('\n')).toContain(`${field} must be plain text`);
		}
	}
});


it('rejects swapped, renamed, missing and extra reader paths', () => {
 const swapped = structuredClone(manifest);
 [swapped.paths[3], swapped.paths[4]] = [swapped.paths[4], swapped.paths[3]];
 expect(validateManifest(swapped, pkg).join('\n')).toContain('path 3 must be tutorial/Tutorial');
 const renamed = structuredClone(manifest);
 renamed.paths[3].key = 'walkthrough';
 expect(validateManifest(renamed, pkg).join('\n')).toContain('path 3 must be tutorial/Tutorial');
 for (const paths of [manifest.paths.slice(0, 7), [...manifest.paths, manifest.paths[0]]]) {
  expect(validateManifest({...manifest, paths}, pkg).join('\n')).toContain('exactly eight ordered paths');
 }
});
