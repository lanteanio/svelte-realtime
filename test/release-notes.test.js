import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { anchorsOf, slugify } from '../scripts/check-links.js';
import {
	governedBlocks, releaseBlocks, renderReleasePage, strayReleaseEntries, SUMMARY_BASELINE,
	validateBlockSummary, validateReleasePages, validateReleaseRouteLinks, validateReleaseSummaries
} from '../scripts/check-release-notes.js';

const CHANGELOG = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8').replace(/\r\n/g, '\n');

function entry(kind, capability = 'the fixture') {
	return [
		`- **${kind}: ${capability}.** The synthetic release fixture keeps one bounded consumer outcome in front of its engineering detail so the suite can prove that coverage is required per existing section and never demanded for a section the release does not contain.`,
		'  - **Affects:** Nobody; this entry exists only inside the suite.',
		'  - **Action:** None.',
		'  - **Requires:** Nothing.',
		'  - **Compatibility:** Unchanged.',
		`  - **Detail:** [${kind} engineering detail](#${kind.toLowerCase()}).`
	].join('\n');
}
function changelog({ heading = '## [Unreleased]', kinds = ['Fixed'], sections = { Fixed: ['- One fixed bullet.'] }, older = '' } = {}) {
	const parts = ['# Changelog', '', heading, '', '<!-- consumer-release-summary:start -->', '### Consumer summary', '', kinds.map(kind => entry(kind)).join('\n'), '', '<!-- consumer-release-summary:end -->', ''];
	for (const [kind, bullets] of Object.entries(sections)) parts.push(`### ${kind}`, '', ...bullets, '');
	if (heading !== '## [Unreleased]') parts.splice(2, 0, '## [Unreleased]', '');
	return parts.join('\n') + older;
}
const unreleased = (source) => releaseBlocks(source)[0];
const history = `\n## [${SUMMARY_BASELINE}] - 2026-10-13\n\n### Fixed\n\n- ${'x'.repeat(2500)}\n`;

describe('consumer release summary', () => {
	it('governs the real Unreleased block and leaves published history alone', () => {
		const governed = validateReleaseSummaries(CHANGELOG);
		expect(governed.map(item => item.block.version)).toEqual(['Unreleased']);
		expect(governed[0].entries.map(e => e.kind)).toEqual(expect.arrayContaining(['Added', 'Changed', 'Fixed']));
		expect(governedBlocks(CHANGELOG.replace(/<!-- consumer-release-summary:start -->[\s\S]*?<!-- consumer-release-summary:end -->\n/, '')).length).toBe(1);
		expect(() => validateReleaseSummaries(CHANGELOG.replace(/<!-- consumer-release-summary:start -->[\s\S]*?<!-- consumer-release-summary:end -->\n/, ''))).toThrow('Unreleased must contain one consumer summary marker pair');
		// An oversized historical bullet at or before the baseline is not governed.
		expect(validateReleaseSummaries(changelog({ older: history }))).toHaveLength(1);
	});
	it('needs no summary while Unreleased is empty', () => {
		expect(validateReleaseSummaries(`# Changelog\n\n## [Unreleased]\n${history}`)).toEqual([]);
	});
	it('rejects short, long and multi-sentence leads', () => {
		const source = changelog();
		expect(() => validateBlockSummary(unreleased(source.replace(/\*\* The synthetic[^\n]+/, '** Too short.')))).toThrow('expected 40-60');
		expect(() => validateBlockSummary(unreleased(source.replace('contain.', 'contain. Another sentence.')))).toThrow(/one outcome sentence|expected 40-60/);
		expect(() => validateBlockSummary(unreleased(source.replace('section the release', 'section, which is a very long way of saying many more words than any reader of a release summary wants to read, the release')))).toThrow('expected 40-60');
	});
	it('rejects missing, reordered and misrouted fields', () => {
		const source = changelog();
		expect(() => validateBlockSummary(unreleased(source.replace('  - **Requires:**', '  - **Prerequisite:**')))).toThrow('in order');
		expect(() => validateBlockSummary(unreleased(source.replace(/( {2}- \*\*Affects:\*\* .+)\n( {2}- \*\*Action:\*\* .+)/, '$2\n$1')))).toThrow('in order');
		expect(() => validateBlockSummary(unreleased(source.replace('(#fixed)', '(#added)')))).toThrow('link to #fixed');
	});
	it('rejects bypass prose, hidden HTML, duplicate markers and wrong placement', () => {
		const source = changelog();
		expect(() => validateBlockSummary(unreleased(source.replace('### Consumer summary\n', '### Consumer summary\n\nRead the story first.\n')))).toThrow('prose outside an entry');
		expect(() => validateBlockSummary(unreleased(source.replace('### Consumer summary', '### Consumer summary\n\n<div hidden>')))).toThrow('raw HTML');
		expect(() => validateBlockSummary(unreleased(source.replace('<!-- consumer-release-summary:start -->', '<!-- consumer-release-summary:start -->\n<!-- consumer-release-summary:start -->')))).toThrow('one consumer summary marker pair');
		expect(() => validateBlockSummary(unreleased(source.replace('## [Unreleased]\n', '## [Unreleased]\n\nIntro first.\n')))).toThrow('first content');
		expect(() => validateBlockSummary(unreleased(source.replace('### Consumer summary', '### Summary')))).toThrow('heading is required');
	});
	it('requires coverage for exactly the kind sections present, in Keep-a-Changelog order', () => {
		expect(validateBlockSummary(unreleased(changelog()))).toHaveLength(1);
		expect(() => validateBlockSummary(unreleased(changelog({ sections: { Changed: ['- c'], Fixed: ['- f'] } })))).toThrow('missing Changed coverage');
		expect(() => validateBlockSummary(unreleased(changelog({ kinds: ['Changed', 'Fixed'] })))).toThrow('links to missing Changed detail');
		expect(() => validateBlockSummary(unreleased(changelog({ kinds: ['Fixed', 'Added'], sections: { Added: ['- a'], Fixed: ['- f'] } })))).toThrow('Keep-a-Changelog order');
		const duplicate = changelog().replace('<!-- consumer-release-summary:end -->', entry('Fixed') + '\n\n<!-- consumer-release-summary:end -->');
		expect(() => validateBlockSummary(unreleased(duplicate))).toThrow('capabilities must be unique');
	});
	it('bounds engineering bullets in new blocks only', () => {
		expect(validateBlockSummary(unreleased(changelog({ sections: { Fixed: ['- ' + 'x'.repeat(1998)] } })))).toHaveLength(1);
		expect(() => validateBlockSummary(unreleased(changelog({ sections: { Fixed: ['- ' + 'x'.repeat(2100)] } })))).toThrow('bound each bullet to 2000');
		const continued = ['- ' + 'y'.repeat(900), '  ' + 'y'.repeat(900), '  ' + 'y'.repeat(900)].join('\n');
		expect(() => validateBlockSummary(unreleased(changelog({ sections: { Fixed: [continued] } })))).toThrow('bound each bullet to 2000');
	});
	it('governs a dated release after the baseline and refuses malformed headings', () => {
		const dated = changelog({ heading: '## [0.6.0-next.92] - 2026-11-02', older: history });
		expect(validateReleaseSummaries(dated).map(item => item.block.version)).toEqual(['0.6.0-next.92']);
		expect(() => validateReleaseSummaries(dated.replace('2026-11-02', '2026-02-30'))).toThrow('real calendar date');
		expect(() => releaseBlocks(dated + '\n## [0.6.0-next.92] - 2026-11-02\n')).toThrow('duplicate release version');
		expect(() => releaseBlocks(dated.replace('## [Unreleased]\n', ''))).toThrow('must open with one undated');
	});
});

describe('versioned release page', () => {
	const dated = changelog({ heading: '## [0.6.0-next.92] - 2026-11-02', kinds: ['Fixed'], older: history });
	const block = releaseBlocks(dated)[1];
	it('pins detail links to the release heading anchor', () => {
		const anchor = slugify(block.heading.slice(3));
		expect(anchorsOf(dated).has(anchor)).toBe(true);
		const page = renderReleasePage(block);
		expect(page).toContain(`](../../CHANGELOG.md#${anchor})`);
		expect(page).not.toContain('CHANGELOG.md#fixed');
		expect(validateReleasePages(dated, new Map([['0.6.0-next.92.md', page]]))).toEqual({ pages: 1, links: 1 });
		expect(() => validateReleasePages(dated, new Map([['0.6.0-next.92.md', '[d](../../CHANGELOG.md#fixed)']]))).toThrow('must pin');
		expect(() => validateReleasePages(dated, new Map([['9.9.9.md', 'orphan']]))).toThrow('does not match any dated CHANGELOG release');
	});
	it('requires README and MIGRATION to route the current page and refuses stray entries', () => {
		const link = './docs/releases/0.6.0-next.92.md';
		expect(validateReleaseRouteLinks('0.6.0-next.92', { 'README.md': link, 'MIGRATION.md': link })).toBe(link);
		expect(() => validateReleaseRouteLinks('0.6.0-next.92', { 'README.md': link, 'MIGRATION.md': '' })).toThrow('MIGRATION.md must contain');
		const file = (name, isFile = true) => ({ name, isFile: () => isFile });
		expect(strayReleaseEntries([file('0.6.0-next.92.md'), file('.DS_Store'), file('notes.txt'), file('drafts', false)])).toEqual(['drafts', 'notes.txt']);
	});
});
