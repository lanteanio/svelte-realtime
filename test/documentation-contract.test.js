import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { PATHS_START, PATHS_END, renderPaths, validateManifest, validateReadme } from '../scripts/check-documentation-contract.js';
const manifest = JSON.parse(readFileSync(new URL('../docs/documentation.v1.json', import.meta.url), 'utf8'));
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8').replace(/\r\n/g, '\n');

it('pins the README ratchet at its actual size with no headroom', () => {
	expect(manifest.readmeMaxLines).toBe(readme.split('\n').length);
	expect(validateReadme(readme, manifest)).toEqual([]);
	expect(validateReadme(readme + '\n', manifest).join('\n')).toContain('size ratchet');
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
