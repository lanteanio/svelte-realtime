import { readFileSync } from 'node:fs';
import { CANDIDATE, NOT_PUBLISHED, validateReleaseLedger } from '../scripts/check-release-ledger.js';
import { describe, expect, it } from 'vitest';
import { anchorsOf, slugify } from '../scripts/check-links.js';
import {
	governedBlocks, rebaseSummaryLinks, releaseBlocks, renderReleasePage, strayReleaseEntries, SUMMARY_BASELINE,
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
	it('governs the newest summary of the real changelog and leaves published history alone', () => {
		const governed = validateReleaseSummaries(CHANGELOG);
		const newest = governed[0];
		expect(newest).toBeDefined();
		expect(newest.entries.map(e => e.kind)).toEqual(expect.arrayContaining(['Added', 'Changed', 'Fixed']));
		// An Unreleased block that gains engineering sections must carry its own
		// summary, even right after a release is cut.
		const pending = CHANGELOG.replace(/^## \[Unreleased\]\n\n(?:<!-- consumer-release-summary:start -->[\s\S]*?<!-- consumer-release-summary:end -->\n\n)?/m, '## [Unreleased]\n\n### Fixed\n\n- A fix waiting for its release.\n\n');
		expect(() => validateReleaseSummaries(pending)).toThrow('Unreleased must contain one consumer summary marker pair');
		const stripped = CHANGELOG.replace(/<!-- consumer-release-summary:start -->[\s\S]*?<!-- consumer-release-summary:end -->\n/, '');
		expect(governedBlocks(stripped).length).toBe(governed.length);
		expect(() => validateReleaseSummaries(stripped)).toThrow(newest.block.version + ' must contain one consumer summary marker pair');
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
	it('rebases summary links written from the repository root onto the page directory', () => {
		expect(rebaseSummaryLinks('see [guide](docs/x.md), [here](./docs/y.md#a), [top](#z), [web](https://e.x/a), [abs](/r)'))
			.toBe('see [guide](../../docs/x.md), [here](../../docs/y.md#a), [top](#z), [web](https://e.x/a), [abs](/r)');
		const linked = changelog({ heading: '## [0.6.0-next.92] - 2026-11-02', older: history }).replace('**Action:** None.', '**Action:** Read [the guide](docs/guide.md).');
		expect(renderReleasePage(releaseBlocks(linked)[1])).toContain('- **Action:** Read [the guide](../../docs/guide.md).');
	});
	it('requires README and MIGRATION to route the current page and refuses stray entries', () => {
		const link = './docs/releases/0.6.0-next.92.md';
		expect(validateReleaseRouteLinks('0.6.0-next.92', { 'README.md': link, 'MIGRATION.md': link })).toBe(link);
		expect(() => validateReleaseRouteLinks('0.6.0-next.92', { 'README.md': link, 'MIGRATION.md': '' })).toThrow('MIGRATION.md must contain');
		const file = (name, isFile = true) => ({ name, isFile: () => isFile });
		expect(strayReleaseEntries([file('0.6.0-next.92.md'), file('.DS_Store'), file('notes.txt'), file('drafts', false)])).toEqual(['drafts', 'notes.txt']);
	});
});

describe('release status marker', () => {
	const manifest = readFileSync(new URL('../docs/release-manifest.md', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
	const summary = changelog().split('## [Unreleased]\n\n')[1].trimEnd();
	const dated = (version, marker) => `## [${version}] - 2026-11-02\n\n${marker === undefined ? '' : marker + '\n\n'}${summary}\n\n`;
	// The real published history from the baseline down, under a synthetic
	// Unreleased block, so these cases do not depend on what is cut above it.
	const baseline = CHANGELOG.search(/^## \[0\.6\.0-next\.91\]/m);
	const preamble = CHANGELOG.slice(0, CHANGELOG.indexOf('## [Unreleased]'));
	const insert = (...blocks) => preamble + '## [Unreleased]\n\n' + summary + '\n\n' + blocks.join('') + CHANGELOG.slice(baseline);

	it('accepts a candidate heading marker in both the ledger and the summary gate', () => {
		const source = insert(dated('0.6.0-next.92', CANDIDATE));
		expect(validateReleaseLedger(manifest, source, '0.6.0-next.92')).toEqual([]);
		expect(validateReleaseSummaries(source).map(item => item.block.version)).toEqual(['Unreleased', '0.6.0-next.92']);
	});
	it('accepts a superseded heading marker below the current candidate in both gates', () => {
		const source = insert(dated('0.6.0-next.93', CANDIDATE), dated('0.6.0-next.92', NOT_PUBLISHED));
		expect(validateReleaseLedger(manifest, source, '0.6.0-next.93')).toEqual([]);
		expect(validateReleaseSummaries(source).map(item => item.block.version)).toEqual(['Unreleased', '0.6.0-next.93', '0.6.0-next.92']);
	});
	it('still refuses any other line, or a second marker, before the summary', () => {
		expect(() => validateReleaseSummaries(insert(dated('0.6.0-next.92', 'Intro first.')))).toThrow('first content');
		expect(() => validateReleaseSummaries(insert(dated('0.6.0-next.92', CANDIDATE + '\n\nIntro first.')))).toThrow('first content');
		expect(() => validateReleaseSummaries(insert(dated('0.6.0-next.92', CANDIDATE + '\n' + CANDIDATE)))).toThrow('first content');
		expect(() => validateReleaseSummaries(insert(dated('0.6.0-next.92', 'Intro first.\n\n' + CANDIDATE)))).toThrow('first content');
		const unreleased = insert().replace('## [Unreleased]\n\n', '## [Unreleased]\n\n' + CANDIDATE + '\n\n');
		expect(() => validateReleaseSummaries(unreleased)).toThrow('Unreleased consumer summary must be the first content');
	});
	it('renders the candidate page without the marker and without claiming a release', () => {
		const source = insert(dated('0.6.0-next.92', CANDIDATE));
		const page = renderReleasePage(releaseBlocks(source)[1]);
		expect(page).not.toContain(CANDIDATE);
		expect(page).not.toContain('Released 2026-11-02');
		expect(page).toContain('Release candidate dated 2026-11-02; not published to npm.');
		const published = renderReleasePage(releaseBlocks(insert(dated('0.6.0-next.92')))[1]);
		expect(published).toContain('Released 2026-11-02.');
	});
});
