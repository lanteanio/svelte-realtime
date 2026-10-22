import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { compareVersions, validateCandidateLifecycles, validateRoutingEvents } from '../scripts/release-policy.js';
import { parseManifest } from '../scripts/check-release-ledger.js';

const HEAD_A = 'a'.repeat(40);
const HEAD_B = 'b'.repeat(40);
const at = (minute) => new Date(Date.UTC(2026, 9, 1, 0, minute)).toISOString();

function release(version, minute, { tag = `svelte-realtime@${version}`, head = HEAD_A } = {}) {
	return {
		Package: 'svelte-realtime', Version: version, 'Target channel': version.includes('-') ? 'next' : 'latest',
		'Git head': head, 'Git tag': tag, 'npm integrity': 'sha512-x', 'npm shasum': 'c'.repeat(40), 'Published UTC': at(minute), Notes: 'note'
	};
}
function event(version, kind, minute, overrides = {}) {
	return {
		Candidate: version, Event: kind, 'Event UTC': at(minute), 'Git head': HEAD_A,
		'Planned tag': `svelte-realtime@${version}`, 'Target channel': version.includes('-') ? 'next' : 'latest', Evidence: 'checks passed', ...overrides
	};
}
function route(id, minute, kind, channel, from, to, overrides = {}) {
	return {
		'Event ID': id, 'Event UTC': at(minute), Event: kind, 'Corrected event': '-', 'Corrected UTC': '-', Package: 'svelte-realtime',
		Channel: channel, 'From version': from, 'To version': to, 'Corrects event': '-', Evidence: 'observed dist-tags', Notes: 'note', ...overrides
	};
}

// Two untagged baseline rows, then one tagged prerelease through the full lifecycle.
const legacy = [release('0.5.0', 1, { tag: 'legacy-none' }), release('0.6.0-next.1', 2, { tag: 'legacy-none' })];
const releases = [...legacy, release('0.6.0-next.2', 5)];
const lifecycle = [event('0.6.0-next.2', 'proposed', 3), event('0.6.0-next.2', 'tagged', 4), event('0.6.0-next.2', 'published', 6)];
const quarantine = [
	route('rt-candidate-open', 7, 'routed', 'candidate', 'none', '0.6.0-next.2'),
	route('rt-next-route', 8, 'routed', 'next', '0.6.0-next.1', '0.6.0-next.2'),
	route('rt-candidate-close', 9, 'routed', 'candidate', '0.6.0-next.2', 'none')
];
const replay = (routing, rows = releases, events = lifecycle) => validateRoutingEvents(routing, rows, validateCandidateLifecycles(events, rows));

describe('candidate lifecycle', () => {
	it('accepts a tagged publication whose row repeats the candidate identity', () => {
		expect(validateCandidateLifecycles(lifecycle, releases).get('svelte-realtime@0.6.0-next.2').event).toBe('published');
	});
	it('rejects identity drift between events and between the events and the row', () => {
		expect(() => validateCandidateLifecycles([lifecycle[0], { ...lifecycle[1], 'Git head': HEAD_B }, lifecycle[2]], releases)).toThrow('candidate identity changed');
		expect(() => validateCandidateLifecycles(lifecycle, [...legacy, release('0.6.0-next.2', 5, { head: HEAD_B })])).toThrow('published Git head differs');
		expect(() => validateCandidateLifecycles([lifecycle[0], { ...lifecycle[1], 'Planned tag': 'svelte-realtime@0.6.0-next.3' }, lifecycle[2]], releases)).toThrow('planned tag differs');
		expect(() => validateCandidateLifecycles([event('0.6.0', 'proposed', 3, { 'Target channel': 'next' })], legacy)).toThrow('wrong target channel');
	});
	it('rejects illegal transitions, orphan rows and orphan events', () => {
		expect(() => validateCandidateLifecycles([lifecycle[0], lifecycle[2]], releases)).toThrow('tagged publication has no tagged event');
		expect(() => validateCandidateLifecycles([lifecycle[1]], releases)).toThrow('invalid candidate transition');
		expect(() => validateCandidateLifecycles([...lifecycle, event('0.6.0-next.2', 'aborted', 10)], releases)).toThrow('invalid candidate transition');
		expect(() => validateCandidateLifecycles([], releases)).toThrow('immutable row has no published event');
		expect(() => validateCandidateLifecycles(lifecycle, legacy)).toThrow('published event has no immutable row');
		expect(() => validateCandidateLifecycles([lifecycle[0], event('0.6.0-next.2', 'aborted', 4)], releases)).toThrow('aborted candidate has an immutable row');
		expect(() => validateCandidateLifecycles([lifecycle[0], lifecycle[1], event('0.6.0-next.2', 'published', 4)], releases)).toThrow('predates registry publication');
		expect(() => validateCandidateLifecycles([event('0.6.0-next.2', 'proposed', 3, { 'Event UTC': '2026-10-01' })], legacy)).toThrow('invalid candidate event');
	});
	it('lets an untagged direct publication skip the tag it never had', () => {
		const direct = [...legacy, release('0.6.0-next.2', 5, { tag: 'legacy-none', head: HEAD_B })];
		const events = [event('0.6.0-next.2', 'proposed', 3), event('0.6.0-next.2', 'published', 6)];
		expect(validateCandidateLifecycles(events, direct).get('svelte-realtime@0.6.0-next.2').event).toBe('published');
	});
});

describe('routing replay', () => {
	it('accepts quarantine, public routing, cleanup and a rollback to a previously routed identity', () => {
		expect(Object.fromEntries(replay(quarantine))).toEqual({ candidate: 'none', latest: '0.5.0', next: '0.6.0-next.2' });
		const rollback = route('rt-next-rollback', 10, 'rollback', 'next', '0.6.0-next.2', '0.6.0-next.1');
		expect(replay([...quarantine, rollback]).get('next')).toBe('0.6.0-next.1');
	});
	it('rejects a malformed rollback', () => {
		const forward = route('rt-rollback-forward', 10, 'rollback', 'next', '0.6.0-next.2', '0.6.0-next.1');
		expect(() => replay([...quarantine, { ...forward, 'From version': '0.6.0-next.1', 'To version': '0.6.0-next.2' }])).toThrow('discontinuous');
		expect(() => replay([...quarantine, { ...forward, Channel: 'candidate', 'From version': 'none', 'To version': '0.6.0-next.1' }])).toThrow();
		expect(() => replay([...quarantine, { ...forward, Channel: 'latest', 'From version': '0.5.0', 'To version': '0.6.0-next.1' }])).toThrow('wrong release channel');
		expect(() => replay([...quarantine, { ...forward, 'To version': 'none' }])).toThrow('two immutable identities');
	});
	it('rejects a rollback to an identity that never occupied the channel', () => {
		const rows = [...legacy, release('0.6.0-next.2', 5), release('0.6.0-next.3', 11)];
		const events = [...lifecycle, event('0.6.0-next.3', 'proposed', 10, { 'Git head': HEAD_B }), event('0.6.0-next.3', 'tagged', 10, { 'Git head': HEAD_B }), event('0.6.0-next.3', 'published', 12, { 'Git head': HEAD_B })];
		const third = [...quarantine,
			route('rt-candidate-3', 13, 'routed', 'candidate', 'none', '0.6.0-next.3'),
			route('rt-next-3', 14, 'routed', 'next', '0.6.0-next.2', '0.6.0-next.3'),
			route('rt-candidate-3-close', 15, 'routed', 'candidate', '0.6.0-next.3', 'none')];
		expect(() => replay(third, [...rows.slice(0, 3), { ...rows[3], 'Git head': HEAD_B }], events)).not.toThrow();
		// 0.6.0-next.2 was never routed to next here, so restoring it is a promotion in disguise.
		const skipped = [route('rt-candidate-2', 7, 'routed', 'candidate', 'none', '0.6.0-next.2'), route('rt-candidate-2-abort', 8, 'routing-aborted', 'candidate', '0.6.0-next.2', 'none'),
			route('rt-candidate-3', 13, 'routed', 'candidate', 'none', '0.6.0-next.3'),
			route('rt-next-3', 14, 'routed', 'next', '0.6.0-next.1', '0.6.0-next.3'),
			route('rt-candidate-3-close', 15, 'routed', 'candidate', '0.6.0-next.3', 'none'),
			route('rt-next-rollback', 16, 'rollback', 'next', '0.6.0-next.3', '0.6.0-next.2')];
		expect(() => replay(skipped, [...rows.slice(0, 3), { ...rows[3], 'Git head': HEAD_B }], events)).toThrow('never previously occupied');
	});
	it('never routes a rolled-back identity forward again', () => {
		const rollback = route('rt-next-rollback', 10, 'rollback', 'next', '0.6.0-next.2', '0.6.0-next.1');
		const again = route('rt-next-again', 11, 'rollback', 'next', '0.6.0-next.1', '0.6.0-next.2');
		expect(() => replay([...quarantine, rollback, again])).toThrow('rejected identity');
	});
	it('rejects orphan and no-op corrections and applies a valid one', () => {
		const orphan = route('rt-fix', 10, 'correction', 'next', '0.6.0-next.1', '0.6.0-next.2', { 'Corrected event': 'routed', 'Corrected UTC': at(8), 'Corrects event': 'rt-missing' });
		expect(() => replay([...quarantine, orphan])).toThrow('correction target must be an earlier event');
		const noop = { ...orphan, 'Corrects event': 'rt-next-route', Evidence: 'observed dist-tags' };
		expect(() => replay([...quarantine, noop])).toThrow('changes no recorded fact');
		expect(() => replay([...quarantine, { ...noop, Evidence: 'registry dist-tags at 00:08' }])).not.toThrow();
		const chained = [...quarantine, { ...noop, Evidence: 'first fix' }, { ...noop, 'Event ID': 'rt-fix-2', Evidence: 'second fix' }];
		expect(() => replay(chained)).toThrow('must extend the latest correction');
		expect(() => replay([quarantine[0], { ...quarantine[1], 'Corrects event': 'rt-candidate-open' }, quarantine[2]])).toThrow('cannot carry corrected fields');
	});
	it('requires a quarantine route for tagged publications and SemVer progress on public routes', () => {
		expect(() => replay([])).toThrow('no candidate quarantine route');
		expect(() => replay([quarantine[1]])).toThrow('requires the active quarantine identity');
		expect(() => replay([quarantine[0], route('rt-abort', 8, 'routing-aborted', 'candidate', '0.6.0-next.2', 'none'), quarantine[1]])).toThrow('requires the active quarantine identity');
		expect(() => replay([quarantine[0], quarantine[1], route('rt-abort', 9, 'routing-aborted', 'candidate', '0.6.0-next.2', 'none')])).toThrow('invalid after target routing');
		expect(() => replay([quarantine[0], quarantine[2]])).toThrow('requires target routing');
		expect(() => replay([{ ...quarantine[0], 'Event UTC': at(5) }, ...quarantine.slice(1)])).toThrow('predates the published candidate event');
	});
	it('records exactly one public route for an untagged publication after routing records begin', () => {
		const rows = [...legacy, release('0.5.1', 20, { tag: 'legacy-none' })];
		const first = route('rt-next', 3, 'routed', 'next', '0.6.0-next.1', '0.6.0-next.1');
		expect(() => validateRoutingEvents([{ ...first, 'To version': '0.6.0-next.1' }], legacy)).toThrow('does not move a pointer');
		const direct = route('rt-latest', 21, 'routed', 'latest', '0.5.0', '0.5.1');
		expect(validateRoutingEvents([direct], rows).get('latest')).toBe('0.5.1');
		// The first routing record dates routing; a later untagged publication must record its own move.
		const earlier = route('rt-other', 10, 'routed', 'latest', '0.5.0', '0.5.1');
		expect(() => validateRoutingEvents([earlier], rows)).toThrow('predates registry publication');
		const unrelated = [release('0.4.0', 0, { tag: 'legacy-none' }), ...rows];
		expect(() => validateRoutingEvents([route('rt-roll', 15, 'rollback', 'latest', '0.5.0', '0.4.0')], unrelated)).toThrow('untagged publication has no recorded route for svelte-realtime@0.5.1');
		expect(() => validateRoutingEvents([direct, route('rt-latest-down', 22, 'routed', 'latest', '0.5.1', '0.5.0')], rows)).toThrow('strictly advance SemVer');
	});
	it('replays the recorded manifest', () => {
		const tables = parseManifest(readFileSync(new URL('../docs/release-manifest.md', import.meta.url), 'utf8'));
		const objects = (name, fields) => tables[name].map((values) => Object.fromEntries(fields.map((field, index) => [field, values[index]])));
		const rows = objects('Published releases', ['Package', 'Version', 'Target channel', 'Git head', 'Git tag', 'npm integrity', 'npm shasum', 'Published UTC', 'Notes']);
		const events = objects('Candidate event log', ['Candidate', 'Event', 'Event UTC', 'Git head', 'Planned tag', 'Target channel', 'Evidence']);
		const routing = objects('Routing, corrections and rollback events', ['Event ID', 'Event UTC', 'Event', 'Corrected event', 'Corrected UTC', 'Package', 'Channel', 'From version', 'To version', 'Corrects event', 'Evidence', 'Notes']);
		const pointers = validateRoutingEvents(routing, rows, validateCandidateLifecycles(events, rows));
		// Each channel ends on the target of its last recorded routing event.
		for (const channel of ['latest', 'next']) {
			const last = routing.filter((row) => row.Channel === channel).at(-1);
			expect(last, channel).toBeDefined();
			expect(pointers.get(channel), channel).toBe(last['To version']);
		}
	});
});

it('orders versions by SemVer precedence', () => {
	const ordered = ['0.5.9', '0.5.10', '0.6.0-alpha', '0.6.0-alpha.1', '0.6.0-alpha.beta', '0.6.0-beta.2', '0.6.0-beta.11', '0.6.0-next.9', '0.6.0-next.10', '0.6.0'];
	for (let index = 1; index < ordered.length; index++) {
		expect(compareVersions(ordered[index - 1], ordered[index]), ordered[index]).toBe(-1);
		expect(compareVersions(ordered[index], ordered[index - 1])).toBe(1);
	}
	expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
	expect(() => compareVersions('1.0.0+build', '1.0.0')).toThrow('invalid release version');
});
