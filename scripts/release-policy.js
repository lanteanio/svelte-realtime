// Candidate lifecycle and dist-tag routing grammar of the release manifest.
const PACKAGE = 'svelte-realtime';
const numeric = '(?:0|[1-9][0-9]*)';
const identifier = `(?:${numeric}|[0-9]*[A-Za-z-][0-9A-Za-z-]*)`;
export const versionPattern = new RegExp(`^${numeric}\\.${numeric}\\.${numeric}(?:-${identifier}(?:\\.${identifier})*)?$`);
const hashPattern = /^[0-9a-f]{40}$/;
// Corrected-event fields of an ordinary routing row hold this placeholder.
const NOT_APPLICABLE = '-';

export function releaseKey(row) {
	return row.Package + '@' + row.Version;
}

export function channelForVersion(version) {
	if (typeof version !== 'string' || !versionPattern.test(version)) throw new Error('invalid release version ' + version);
	return version.includes('-') ? 'next' : 'latest';
}

/** SemVer precedence of two exact versions without build metadata. */
export function compareVersions(a, b) {
	channelForVersion(a);
	channelForVersion(b);
	const [coreA, preA] = split(a);
	const [coreB, preB] = split(b);
	for (let index = 0; index < 3; index++) {
		if (coreA[index] !== coreB[index]) return coreA[index] < coreB[index] ? -1 : 1;
	}
	if (!preA.length || !preB.length) return preA.length === preB.length ? 0 : preA.length ? -1 : 1;
	for (let index = 0; index < Math.max(preA.length, preB.length); index++) {
		const x = preA[index];
		const y = preB[index];
		if (x === undefined) return -1;
		if (y === undefined) return 1;
		if (x === y) continue;
		const xNumeric = /^[0-9]+$/.test(x);
		const yNumeric = /^[0-9]+$/.test(y);
		if (xNumeric && yNumeric) return BigInt(x) < BigInt(y) ? -1 : 1;
		if (xNumeric !== yNumeric) return xNumeric ? -1 : 1;
		return x < y ? -1 : 1;
	}
	return 0;
}

function split(version) {
	const dash = version.indexOf('-');
	const core = (dash < 0 ? version : version.slice(0, dash)).split('.').map(BigInt);
	return [core, dash < 0 ? [] : version.slice(dash + 1).split('.')];
}

export function eventTime(value, context) {
	if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
		throw new Error('invalid ' + context + ' UTC');
	}
	const parsed = Date.parse(value);
	if (Number.isNaN(parsed) || new Date(parsed).toISOString() !== value) throw new Error('invalid ' + context + ' UTC');
	return parsed;
}

const tagged = (row) => row['Git tag'] !== 'legacy-none';

/**
 * Validate candidate events against the published rows. A tagged publication
 * runs proposed -> tagged -> published with one Git head, planned tag and
 * channel, and its immutable row repeats them. A direct publication without a
 * release tag records `legacy-none`; its candidate events, when present, may
 * go from proposed straight to published because no tag exists to record.
 */
export function validateCandidateLifecycles(events, releases) {
	const rowsByKey = new Map();
	for (const row of releases) {
		const key = releaseKey(row);
		if (row['Target channel'] !== channelForVersion(row.Version)) {
			throw new Error('release version has the wrong target channel for ' + key);
		}
		eventTime(row['Published UTC'], 'published release ' + key);
		if (rowsByKey.has(key)) throw new Error('duplicate immutable row for ' + key);
		rowsByKey.set(key, row);
	}
	const state = new Map();
	for (const event of events) {
		const version = event.Candidate;
		const candidate = PACKAGE + '@' + version;
		try {
			channelForVersion(version);
		} catch {
			throw new Error('invalid candidate identity ' + version);
		}
		if (!['proposed', 'tagged', 'aborted', 'published'].includes(event.Event)) {
			throw new Error('invalid candidate event for ' + candidate);
		}
		const time = eventTime(event['Event UTC'], 'candidate event for ' + candidate);
		if (!hashPattern.test(event['Git head'])) throw new Error('invalid candidate Git head for ' + candidate);
		if (event['Planned tag'] !== candidate) throw new Error('planned tag differs from candidate ' + candidate);
		if (event['Target channel'] !== channelForVersion(version)) {
			throw new Error('candidate version has the wrong target channel for ' + candidate);
		}
		if (!event.Evidence) throw new Error('candidate evidence is required for ' + candidate);
		const previous = state.get(candidate);
		const allowed = previous === undefined ? ['proposed']
			: previous.event === 'proposed' ? ['tagged', 'aborted', 'published']
				: previous.event === 'tagged' ? ['published', 'aborted'] : [];
		if (!allowed.includes(event.Event)) {
			throw new Error('invalid candidate transition ' + candidate + ': ' + (previous?.event ?? 'none') + ' -> ' + event.Event);
		}
		const identity = { gitHead: event['Git head'], plannedTag: event['Planned tag'], targetChannel: event['Target channel'] };
		if (previous !== undefined) {
			for (const field of Object.keys(identity)) {
				if (identity[field] !== previous.identity[field]) throw new Error('candidate identity changed for ' + candidate + ': ' + field);
			}
			if (time < previous.eventTime) throw new Error('candidate events are not chronological for ' + candidate);
		}
		state.set(candidate, {
			event: event.Event,
			eventTime: time,
			identity,
			eventTimes: { ...(previous?.eventTimes ?? {}), [event.Event]: time }
		});
	}
	for (const [candidate, finalState] of state) {
		const release = rowsByKey.get(candidate);
		if (finalState.event === 'published' && release === undefined) throw new Error('published event has no immutable row for ' + candidate);
		if (finalState.event === 'aborted' && release !== undefined) throw new Error('aborted candidate has an immutable row for ' + candidate);
		if (release === undefined) continue;
		if (finalState.event !== 'published') throw new Error('immutable row has no published event for ' + candidate);
		const publishedTime = eventTime(release['Published UTC'], 'published release ' + candidate);
		if (release['Target channel'] !== finalState.identity.targetChannel) {
			throw new Error('published target channel differs from candidate ' + candidate);
		}
		if (tagged(release)) {
			if (finalState.eventTimes.tagged === undefined) throw new Error('tagged publication has no tagged event for ' + candidate);
			if (release['Git head'] !== finalState.identity.gitHead) throw new Error('published Git head differs from candidate ' + candidate);
			if (release['Git tag'] !== finalState.identity.plannedTag) throw new Error('published Git tag differs from candidate ' + candidate);
		}
		for (const name of ['proposed', 'tagged']) {
			if ((finalState.eventTimes[name] ?? 0) > publishedTime) {
				throw new Error(name + ' candidate event follows registry publication for ' + candidate);
			}
		}
		if (finalState.eventTime < publishedTime) throw new Error('published candidate event predates registry publication for ' + candidate);
	}
	for (const [key, row] of rowsByKey) {
		if (tagged(row) && state.get(key)?.event !== 'published') throw new Error('immutable row has no published event for ' + key);
	}
	return state;
}

/**
 * Replay dist-tag routing. Each public channel starts at an untagged baseline
 * row: the source of its first recorded event, or its newest untagged row
 * while none is recorded. From then on, a
 * tagged publication opens and closes the `candidate` quarantine around its
 * public route, while an untagged direct publication records the one public
 * route its publish performed. Public routes advance SemVer; rollback moves
 * back to an identity that previously occupied the channel, and a rolled-back
 * identity is never routed forward again. Returns the current pointers.
 */
export function validateRoutingEvents(events, releases, lifecycles = new Map()) {
	const releasesByKey = new Map();
	for (const row of releases) {
		const key = releaseKey(row);
		if (releasesByKey.has(key)) throw new Error('duplicate immutable routing identity ' + key);
		if (row['Target channel'] !== channelForVersion(row.Version)) throw new Error('release version has the wrong target channel for ' + key);
		eventTime(row['Published UTC'], 'published release ' + key);
		releasesByKey.set(key, row);
	}
	for (const row of releases) {
		if (tagged(row) && lifecycles.get(releaseKey(row))?.event !== 'published') {
			throw new Error('published identity has no complete candidate lifecycle for ' + releaseKey(row));
		}
	}
	const rowsById = new Map();
	const rootById = new Map();
	const effectiveByRoot = new Map();
	const latestCorrectionByRoot = new Map();
	let lastRecordedTime = 0;
	for (const row of events) {
		const id = row['Event ID'];
		if (!/^[a-z0-9][a-z0-9._-]{2,79}$/.test(id)) throw new Error('invalid routing event ID ' + id);
		if (rowsById.has(id)) throw new Error('duplicate routing event ID ' + id);
		const recordedTime = eventTime(row['Event UTC'], 'routing event for ' + id);
		if (recordedTime < lastRecordedTime) throw new Error('routing ledger records are not chronological at ' + id);
		lastRecordedTime = recordedTime;
		if (!['routed', 'routing-aborted', 'rollback', 'correction'].includes(row.Event)) throw new Error('invalid routing event type for ' + id);
		if (row.Package !== PACKAGE) throw new Error('invalid routing package for ' + id);
		if (!['latest', 'next', 'candidate'].includes(row.Channel)) throw new Error('invalid routing channel for ' + id);
		if (!row.Evidence || !row.Notes) throw new Error('routing evidence and notes are required for ' + id);
		if (row.Event === 'correction') {
			if (!['routed', 'routing-aborted', 'rollback'].includes(row['Corrected event'])) throw new Error('invalid corrected routing event type for ' + id);
			const correctedTime = eventTime(row['Corrected UTC'], 'corrected routing event for ' + id);
			if (correctedTime > recordedTime) throw new Error('correction predates its corrected fact for ' + id);
			const correctedId = row['Corrects event'];
			if (!rowsById.has(correctedId)) throw new Error('correction target must be an earlier event for ' + id);
			const root = rootById.get(correctedId);
			if (latestCorrectionByRoot.get(root) !== correctedId) throw new Error('correction must extend the latest correction for ' + root);
			const prior = effectiveByRoot.get(root);
			const replacement = {
				...prior,
				Event: row['Corrected event'],
				'Event UTC': row['Corrected UTC'],
				Package: row.Package,
				Channel: row.Channel,
				'From version': row['From version'],
				'To version': row['To version'],
				Evidence: row.Evidence,
				Notes: row.Notes
			};
			const fields = ['Event', 'Event UTC', 'Package', 'Channel', 'From version', 'To version', 'Evidence', 'Notes'];
			if (fields.every((field) => replacement[field] === prior[field])) throw new Error('correction changes no recorded fact for ' + id);
			rootById.set(id, root);
			effectiveByRoot.set(root, replacement);
			latestCorrectionByRoot.set(root, id);
		} else {
			if ([row['Corrected event'], row['Corrected UTC'], row['Corrects event']].some((value) => value !== NOT_APPLICABLE)) {
				throw new Error('non-correction event cannot carry corrected fields for ' + id);
			}
			rootById.set(id, id);
			effectiveByRoot.set(id, row);
			latestCorrectionByRoot.set(id, id);
		}
		rowsById.set(id, row);
	}

	// A channel's baseline is the source of its first recorded event, or its newest
	// untagged row when nothing was recorded. Later untagged rows each owe one route.
	const firstSource = new Map();
	for (const row of effectiveByRoot.values()) {
		if (row.Channel !== 'candidate' && !firstSource.has(row.Channel)) firstSource.set(row.Channel, row['From version']);
	}
	const current = new Map([['candidate', 'none']]);
	const previouslyRouted = new Map([['candidate', new Set(['none'])], ['latest', new Set()], ['next', new Set()]]);
	const directRoutes = new Map();
	for (const channel of ['latest', 'next']) {
		const untagged = releases.filter((row) => !tagged(row) && row['Target channel'] === channel);
		if (!untagged.length) continue;
		const newest = untagged.reduce((a, b) => (b['Published UTC'] > a['Published UTC'] ? b : a));
		const baseline = firstSource.has(channel) ? releasesByKey.get(PACKAGE + '@' + firstSource.get(channel)) : newest;
		if (!baseline || tagged(baseline) || baseline['Target channel'] !== channel) {
			throw new Error('routing baseline for ' + channel + ' must be an untagged release on that channel');
		}
		for (const row of untagged) {
			if (row['Published UTC'] <= baseline['Published UTC']) previouslyRouted.get(channel).add(row.Version);
			else directRoutes.set(releaseKey(row), 0);
		}
		current.set(channel, baseline.Version);
	}
	let lastEffectiveTime = 0;
	let activeQuarantine = null;
	const quarantinedIdentities = new Set();
	const rejectedIdentities = new Set();
	for (const [root, row] of effectiveByRoot) {
		const fromVersion = row['From version'];
		const toVersion = row['To version'];
		const fromRelease = fromVersion === 'none' ? undefined : releasesByKey.get(PACKAGE + '@' + fromVersion);
		const toRelease = toVersion === 'none' ? undefined : releasesByKey.get(PACKAGE + '@' + toVersion);
		if (fromVersion !== 'none' && fromRelease === undefined) throw new Error('routing source is not an immutable release for ' + root);
		if (toVersion !== 'none' && toRelease === undefined) throw new Error('routing target is not an immutable release for ' + root);
		if (fromVersion === toVersion) throw new Error('routing event does not move a pointer for ' + root);
		if (row.Channel !== 'candidate' && (fromRelease === undefined || toRelease === undefined)) {
			throw new Error('public routing requires two immutable identities for ' + root);
		}
		if (current.get(row.Channel) !== fromVersion) throw new Error('routing history is discontinuous for ' + row.Channel + ' at ' + root);
		const time = eventTime(row['Event UTC'], 'effective routing event for ' + root);
		if (time < lastEffectiveTime) throw new Error('effective routing events are not chronological at ' + root);
		lastEffectiveTime = time;
		for (const release of [fromRelease, toRelease].filter(Boolean)) {
			const key = releaseKey(release);
			if (time < eventTime(release['Published UTC'], 'published release ' + key)) throw new Error('routing event predates registry publication for ' + root);
			if (tagged(release) && time < lifecycles.get(key).eventTime) {
				throw new Error('routing event predates the published candidate event for ' + root);
			}
		}
		if (row.Channel !== 'candidate' && rejectedIdentities.has(releaseKey(toRelease))) {
			throw new Error('rejected identity cannot be routed forward again for ' + root);
		}
		if (row.Event === 'routed') {
			if (row.Channel === 'candidate') {
				const closes = activeQuarantine !== null && fromVersion === activeQuarantine.version && toVersion === activeQuarantine.prior;
				if (closes) {
					if (!activeQuarantine.targetRouted) throw new Error('successful quarantine cleanup requires target routing for ' + root);
					activeQuarantine = null;
				} else {
					if (activeQuarantine !== null) throw new Error('active quarantine must be restored before ' + root);
					if (toRelease === undefined || !tagged(toRelease)) throw new Error('candidate routing requires a newly published tagged identity for ' + root);
					const identity = releaseKey(toRelease);
					if (quarantinedIdentities.has(identity)) throw new Error('immutable identity cannot open candidate quarantine more than once for ' + root);
					quarantinedIdentities.add(identity);
					activeQuarantine = { version: toVersion, prior: fromVersion, targetChannel: toRelease['Target channel'], targetRouted: false, quarantineTime: time };
				}
			} else {
				if (toRelease['Target channel'] !== row.Channel) throw new Error('routed target has the wrong release channel for ' + root);
				if (compareVersions(toVersion, fromVersion) <= 0) throw new Error('routed public transition must strictly advance SemVer for ' + root);
				if (!tagged(toRelease)) {
					const key = releaseKey(toRelease);
					if (directRoutes.get(key) !== 0) throw new Error('untagged identity has no direct publication route left for ' + root);
					directRoutes.set(key, 1);
				} else {
					if (activeQuarantine === null || activeQuarantine.version !== toVersion || activeQuarantine.targetChannel !== row.Channel) {
						throw new Error('target routing requires the active quarantine identity for ' + root);
					}
					if (time < activeQuarantine.quarantineTime) throw new Error('target routing predates quarantine publication for ' + root);
					if (activeQuarantine.rolledBack) throw new Error('rolled-back identity cannot be routed forward again for ' + root);
					activeQuarantine.targetRouted = true;
				}
			}
		} else if (row.Event === 'rollback') {
			if (row.Channel === 'candidate') throw new Error('rollback requires two target-channel identities for ' + root);
			if (fromRelease['Target channel'] !== row.Channel || toRelease['Target channel'] !== row.Channel) {
				throw new Error('rollback identity has the wrong release channel for ' + root);
			}
			if (!previouslyRouted.get(row.Channel).has(toVersion)) throw new Error('rollback target never previously occupied ' + row.Channel + ' for ' + root);
			if (compareVersions(toVersion, fromVersion) >= 0) throw new Error('rollback must move backward in SemVer for ' + root);
			if (activeQuarantine !== null && activeQuarantine.version === fromVersion && activeQuarantine.targetChannel === row.Channel) {
				activeQuarantine.rolledBack = true;
			}
			rejectedIdentities.add(releaseKey(fromRelease));
		} else if (row.Event === 'routing-aborted') {
			if (row.Channel !== 'candidate' || fromRelease === undefined || !tagged(fromRelease) || activeQuarantine === null || activeQuarantine.version !== fromVersion) {
				throw new Error('routing-aborted must restore the candidate pointer for ' + root);
			}
			if (activeQuarantine.targetRouted) throw new Error('routing-aborted is invalid after target routing for ' + root);
			if (toVersion !== activeQuarantine.prior) throw new Error('routing-aborted must restore the captured candidate pointer for ' + root);
			activeQuarantine = null;
		}
		current.set(row.Channel, toVersion);
		previouslyRouted.get(row.Channel).add(toVersion);
	}
	for (const row of releases) {
		const key = releaseKey(row);
		if (tagged(row) && !quarantinedIdentities.has(key)) throw new Error('published identity has no candidate quarantine route for ' + key);
		if (directRoutes.get(key) === 0) throw new Error('untagged publication has no recorded route for ' + key);
	}
	return current;
}
