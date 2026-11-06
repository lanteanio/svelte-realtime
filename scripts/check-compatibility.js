#!/usr/bin/env node
// Generate and validate the documented ecosystem tuple from the compatibility
// manifest the installed svelte-adapter-uws ships. The README table, install
// commands and quick start pin are bounded generated blocks; the package
// floors, Node engine, scaffolder tuple, first-run transcript and the prose
// that restates manifest facts must agree with the manifest's current row.
//
// The row rules mirror the adapter's own scripts/check-compatibility.js. The
// adapter additionally pins each published baseline row to a digest of its
// registry release; that pin is the adapter's release gate, so the installed
// manifest has already passed it.
//
// --write rewrites only the bounded README blocks and the restated facts.
// --release additionally requires this package's version to be the realtime
// release the manifest declares; during development the version may run
// ahead of the published adapter, so the normal check only requires it to
// stay inside the declared series.
import { isScriptEntry } from './script-entry.js';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import semver from 'semver';
import {
	SCAFFOLD_ADAPTER_SPEC,
	SCAFFOLD_EXTENSIONS_SPEC,
	SCAFFOLD_REALTIME_SPEC,
	SCAFFOLD_UWS_SPEC
} from '../src/cli-utils.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const MANIFEST_PATH = 'node_modules/svelte-adapter-uws/docs/compatibility.v1.csv';
const ADAPTER_PACKAGE_PATH = 'node_modules/svelte-adapter-uws/package.json';
export const EXPECTED_HEADERS = [
	'schema_version', 'owner', 'current', 'channel', 'dist_tag', 'adapter_version', 'provenance',
	'adapter', 'realtime', 'extensions', 'node', 'uwebsockets', 'train', 'realtime_version',
	'extensions_version', 'realtime_head', 'extensions_head', 'wire_protocol', 'procedure',
	'sveltekit', 'realtime_adapter_floor', 'extensions_adapter_floor'
];
const TRAIN_FACT_FIELDS = ['realtime_version', 'extensions_version', 'realtime_head', 'extensions_head', 'wire_protocol', 'procedure', 'sveltekit'];
// The lowest exact adapter release each sibling train declares as its peer.
// Every tagged row carries both; the untagged legacy row carries neither.
const ADAPTER_FLOOR_FIELDS = ['realtime_adapter_floor', 'extensions_adapter_floor'];
const CHANNEL_TAGS = new Map([['legacy', ''], ['stable', 'latest'], ['prerelease', 'next']]);
const SERIES = /^\d+\.\d+\.(?:x|\d+(?:-[0-9A-Za-z.-]+)?)$/;
const TRAIN = /^\d+\.\d+$/;
const GIT_HEAD = /^[0-9a-f]{40}$/;
const WIRE_PROTOCOL = /^[1-9]\d*$/;
const PROCEDURE_ANCHOR = /^docs\/releasing\.md#[a-z0-9-]+$/;
const UWS_SPEC = /^(?:https:\/\/github\.com\/uNetworking\/uWebSockets\.js\/archive\/refs\/tags\/v\d+\.\d+\.\d+\.tar\.gz|github:uNetworking\/uWebSockets\.js#v\d+\.\d+\.\d+)$/;
const UNPRINTABLE = new RegExp('[\\x00-\\x1f\\x7f' + String.fromCharCode(0x2028, 0x2029) + '`]');

// The adapter release each documented svelte-realtime train declares as its
// peer floor. The manifest has to keep listing these trains. A non-current
// row that carries realtime_adapter_floor is rendered from that column; this value
// stands in where no row of the train carries it, such as an untagged legacy
// row. svelte-realtime 0.5.x declares svelte-adapter-uws ^0.5.11.
export const ADAPTER_FLOORS = new Map([['0.5', '0.5.11']]);

export const UPGRADE_GUIDE = 'docs/0.6-upgrade.md';
const NODE_PHRASE = '(Node \\d+(?:\\.\\d+){0,2} or newer|a Node version in `[^`]+`)';
// Prose that restates manifest facts. Each pattern must match exactly once in
// its file with the stated value in group 1, so a reworded or deleted
// statement fails the check instead of silently escaping it.
export const STATEMENTS = [
	{ file: UPGRADE_GUIDE, pattern: new RegExp('sibling packages\\s+require ' + NODE_PHRASE), value: (current) => nodeRequirement(current.node) },
	{ file: UPGRADE_GUIDE, pattern: /`svelte-adapter-uws`\s+`\^([^`]+)` as a peer/, value: (current) => realtimeFloor(current) },
	{ file: UPGRADE_GUIDE, pattern: /\| `0\.5\.x` \((\d+\.\d+\.\d+) or later\) \|/, value: (_current, rows = []) => realtimeFloor(rows.find((row) => row.train === '0.5') ?? { train: '0.5' }) },
	{ file: UPGRADE_GUIDE, pattern: /\| matching `([^`]+)`, at least `[^`]+` \|/, value: (current) => current.adapter },
	{ file: UPGRADE_GUIDE, pattern: /\| matching `[^`]+`, at least `([^`]+)` \|/, value: (current) => realtimeFloor(current) },
	{ file: UPGRADE_GUIDE, pattern: /\| exact `([^`]+)` \| matching `[^`]+`, at least/, value: (current) => (current.realtime.endsWith('.x') ? current.realtime : current.realtime + '.*') },
	{ file: UPGRADE_GUIDE, pattern: /, at least `[^`]+` \| matching `([^`]+)` \|/, value: (current) => current.extensions },
	{ file: 'README.md', pattern: new RegExp('the pinned native server supports ' + NODE_PHRASE + ' with a matching'), value: (current) => nodeRequirement(current.node) }
];

/** The adapter floor the row's svelte-realtime release declares as its peer. */
export function realtimeFloor(row) {
	return row.realtime_adapter_floor || ADAPTER_FLOORS.get(row.train) || row.adapter_version;
}

/** The Node range as prose: a plain lower bound keeps its full precision. */
export function nodeRequirement(range) {
	const set = new semver.Range(range).set;
	const bound = set.length === 1 && set[0].length === 1 && set[0][0].operator === '>=' ? set[0][0].semver : null;
	if (!bound || bound.prerelease.length) return 'a Node version in `' + range + '`';
	const version = bound.patch ? bound.version : bound.minor ? bound.major + '.' + bound.minor : String(bound.major);
	return 'Node ' + version + ' or newer';
}

/** Split the manifest exactly as the adapter does: trimmed lines, plain commas. */
export function parseManifest(text) {
	if (text.trim() === '') throw new Error('Compatibility manifest is empty');
	const lines = text.trim().split(/\r?\n/);
	const headers = lines.shift()?.split(',') || [];
	if (headers.length !== EXPECTED_HEADERS.length || headers.some((header, index) => header !== EXPECTED_HEADERS[index])) {
		const duplicates = headers.filter((header, index) => headers.indexOf(header) !== index);
		const missing = EXPECTED_HEADERS.filter((header) => !headers.includes(header));
		const unexpected = headers.filter((header) => !EXPECTED_HEADERS.includes(header));
		const detail = [
			duplicates.length && 'duplicate ' + [...new Set(duplicates)].join(', '),
			missing.length && 'missing ' + missing.join(', '),
			unexpected.length && 'unexpected ' + unexpected.join(', ')
		].filter(Boolean).join('; ') || 'columns out of order';
		throw new Error('Compatibility manifest header must be exactly ' + EXPECTED_HEADERS.join(',') + ' (' + detail + ')');
	}
	return lines.map((line, index) => {
		const values = line.split(',');
		if (values.length !== headers.length) throw new Error('Compatibility manifest row ' + (index + 2) + ' has ' + values.length + ' fields; expected ' + headers.length);
		return Object.fromEntries(headers.map((header, column) => [header, values[column]]));
	});
}

function validNodeRange(value) {
	return typeof value === 'string' && value === value.trim() && !UNPRINTABLE.test(value) && semver.validRange(value, { loose: false }) !== null;
}

function matchesSeries(version, series) {
	if (series.endsWith('.x')) return version.startsWith(series.slice(0, -1));
	return version === series || version.startsWith(series + '.');
}

/** The adapter's manifest rules that do not need the adapter repository's own files. */
export function validateRows(rows) {
	const errors = [];
	const channels = [...CHANNEL_TAGS.keys()];
	if (rows.length !== channels.length) errors.push('channels must be exactly legacy, stable, prerelease');
	const currentRows = rows.filter((row) => row.current === 'true');
	if (currentRows.length !== 1) errors.push('exactly one compatibility row must be current; found ' + currentRows.length);
	const seen = new Set();
	for (const [index, row] of rows.entries()) {
		const label = row.channel || 'row ' + (index + 2);
		for (const [field, value] of Object.entries(row)) {
			if (typeof value !== 'string' || UNPRINTABLE.test(value)) errors.push(label + ': ' + field + ' must be a single printable line');
		}
		if (row.schema_version !== '1') errors.push(label + ': unsupported schema_version');
		if (row.owner !== 'svelte-adapter-uws') errors.push(label + ': owner must be svelte-adapter-uws');
		if (row.current !== 'true' && row.current !== 'false') errors.push(label + ': current must be true or false');
		if (row.channel !== channels[index]) errors.push('channels must be ordered legacy, stable, prerelease');
		if (seen.has(row.channel)) errors.push(label + ': duplicate channel');
		seen.add(row.channel);
		if (!CHANNEL_TAGS.has(row.channel)) errors.push(label + ': unknown channel');
		else if (row.dist_tag !== CHANNEL_TAGS.get(row.channel)) errors.push(label + ': invalid dist tag role');
		for (const field of ['adapter', 'realtime', 'extensions']) if (!SERIES.test(row[field])) errors.push(label + ': invalid ' + field + ' series');
		if (!row.dist_tag) {
			if (row.node || row.uwebsockets || row.adapter_version || row.provenance || ADAPTER_FLOOR_FIELDS.some((field) => row[field])) errors.push(label + ': untagged legacy channel must not claim release or runtime facts');
		} else {
			if (!row.adapter_version || !matchesSeries(row.adapter_version, row.adapter)) errors.push(label + ': adapter release identity is outside its series');
			if (!validNodeRange(row.node)) errors.push(label + ': node must be a canonical single-line npm semver range');
			if (!UWS_SPEC.test(row.uwebsockets)) errors.push(label + ': uWebSockets.js must be an exact tagged GitHub source');
			if (row.current === 'false' && row.provenance !== 'npm:svelte-adapter-uws@' + row.adapter_version) errors.push(label + ': published baseline provenance is not pinned');
			for (const field of ADAPTER_FLOOR_FIELDS) {
				const floor = row[field];
				if (semver.valid(floor) !== floor || !matchesSeries(floor, row.adapter)) errors.push(label + ': ' + field + ' must be an exact adapter release inside the series ' + row.adapter);
				else if (semver.valid(row.adapter_version) === row.adapter_version && semver.gt(floor, row.adapter_version)) errors.push(label + ': ' + field + ' ' + floor + ' is above the row\'s adapter release ' + row.adapter_version);
			}
		}
		if (!TRAIN.test(row.train)) errors.push(label + ': train must be a major.minor release train');
		else if (!(row.adapter.startsWith(row.train + '.') || row.adapter === row.train + '.x')) errors.push(label + ': train ' + row.train + ' does not prefix the adapter series ' + row.adapter);
		const present = TRAIN_FACT_FIELDS.filter((field) => row[field]);
		if (present.length !== 0 && present.length !== TRAIN_FACT_FIELDS.length) errors.push(label + ': train release facts form one unit and must be all present or all empty');
		if (row.current === 'true' && present.length !== TRAIN_FACT_FIELDS.length) errors.push(label + ': current row must record every train release fact');
		if (present.length === TRAIN_FACT_FIELDS.length) {
			for (const [field, series] of [['realtime_version', row.realtime], ['extensions_version', row.extensions]]) {
				if (!matchesSeries(row[field], series)) errors.push(label + ': ' + field + ' release identity is outside its series');
			}
			for (const field of ['realtime_head', 'extensions_head']) if (!GIT_HEAD.test(row[field])) errors.push(label + ': ' + field + ' must be a full lowercase git head');
			if (!WIRE_PROTOCOL.test(row.wire_protocol)) errors.push(label + ': wire_protocol must be a positive integer revision');
			if (row.procedure.split(' ').some((token) => !PROCEDURE_ANCHOR.test(token))) errors.push(label + ': procedure must be space-separated docs/releasing.md anchors');
			const kits = row.sveltekit.split(' ');
			if (kits.some((version, index) => semver.valid(version) !== version || (index > 0 && !semver.gt(version, kits[index - 1])))) errors.push(label + ': sveltekit must be space-separated exact SvelteKit versions in ascending order');
		}
	}
	if (currentRows.length === 1) {
		const current = currentRows[0];
		if (!current.dist_tag) errors.push('current channel has no dist tag');
		if (current.provenance !== 'workspace') errors.push('current channel provenance must be workspace');
		for (const field of ['realtime', 'extensions']) {
			if (current[field] !== current.adapter) errors.push(current.channel + ': ' + field + ' series ' + current[field] + ' does not match the lockstep adapter series ' + current.adapter);
		}
		if (current.channel !== (String(current.adapter_version).includes('-') ? 'prerelease' : 'stable')) errors.push('current channel does not match the adapter version stability');
	}
	for (const [train, floor] of ADAPTER_FLOORS) {
		const row = rows.find((candidate) => candidate.train === train);
		if (!row) errors.push('the manifest no longer lists the ' + train + ' train; remove it from ADAPTER_FLOORS');
		else if (semver.valid(floor) !== floor || !matchesSeries(floor, row.adapter)) errors.push('adapter floor ' + floor + ' is not an exact release inside the ' + train + ' adapter series ' + row.adapter);
	}
	return errors;
}

export function currentRow(rows) {
	const errors = validateRows(rows);
	if (errors.length) throw new Error('Compatibility manifest is invalid:\n' + errors.join('\n'));
	return rows.find((row) => row.current === 'true');
}

/**
 * Whether this package's version belongs to the manifest's realtime series.
 * The stable cut of a prerelease series (0.6.0 for 0.6.0-next) counts, so
 * this package can take its release version before the adapter publishes the
 * stable manifest; --release still requires the exact declared version.
 * A version below the declared release also passes: the adapter can declare
 * the next realtime release before this package bumps its version, which
 * happens only when the release is cut.
 */
export function inRealtimeSeries(version, series) {
	if (matchesSeries(version, series)) return true;
	const cut = /^(\d+\.\d+\.\d+)-/.exec(series);
	return cut !== null && version === cut[1];
}

export function validatePackage(pkg, current, { release = false } = {}) {
	const errors = [];
	if (pkg.engines?.node !== current.node) errors.push('package.json engines.node ' + JSON.stringify(pkg.engines?.node) + ' differs from the manifest Node prerequisite ' + current.node);
	const peer = pkg.peerDependencies?.['svelte-adapter-uws'];
	// The row records the floor of the realtime release it pairs with, the
	// lowest version of that release's peer range. A checkout at another
	// version is not that release; during development the peer follows the
	// current adapter. The paired release declares the caret range the upgrade
	// guide states, and it has to admit the adapter the row installs it with.
	if (current.realtime_adapter_floor && pkg.version === current.realtime_version) {
		if (peer !== '^' + current.realtime_adapter_floor) errors.push('Adapter peer floor ' + JSON.stringify(peer) + ' differs from the manifest realtime_adapter_floor; expected ^' + current.realtime_adapter_floor);
		else if (!semver.satisfies(current.adapter_version, peer)) errors.push('Adapter peer ' + peer + ' does not admit the manifest adapter release ' + current.adapter_version);
	} else if (peer !== '^' + current.adapter_version) errors.push('Adapter peer floor ' + JSON.stringify(peer) + ' differs from the manifest; expected ^' + current.adapter_version);
	if (pkg.devDependencies?.['svelte-adapter-uws-extensions'] !== '^' + current.extensions_version) errors.push('Extensions development floor ' + JSON.stringify(pkg.devDependencies?.['svelte-adapter-uws-extensions']) + ' differs from the manifest; expected ^' + current.extensions_version);
	if (release) {
		if (pkg.version !== current.realtime_version) errors.push('Publishing ' + pkg.version + ' but the manifest declares svelte-realtime ' + current.realtime_version + '; install the adapter release that declares this version first');
	} else if (!inRealtimeSeries(pkg.version, current.realtime)) {
		errors.push('package version ' + pkg.version + ' is outside the manifest realtime series ' + current.realtime);
	}
	return errors;
}

export function validateInstalledAdapter(adapter, current) {
	const errors = [];
	if (adapter.version !== current.adapter_version) errors.push('Installed svelte-adapter-uws ' + adapter.version + ' is not the manifest current adapter ' + current.adapter_version + '; reinstall dependencies');
	if (adapter.optionalDependencies?.['uWebSockets.js'] !== current.uwebsockets) errors.push('Installed adapter native pin differs from the manifest uwebsockets value');
	if (adapter.engines?.node !== current.node) errors.push('Installed adapter engines.node ' + JSON.stringify(adapter.engines?.node) + ' differs from the manifest Node prerequisite ' + current.node);
	if (adapter.publishConfig?.tag !== current.dist_tag) errors.push('Installed adapter publishConfig.tag ' + JSON.stringify(adapter.publishConfig?.tag) + ' differs from the manifest dist tag ' + current.dist_tag);
	return errors;
}

export function expectedScaffoldSpecs(current) {
	return {
		SCAFFOLD_ADAPTER_SPEC: 'svelte-adapter-uws@' + current.adapter_version,
		SCAFFOLD_REALTIME_SPEC: 'svelte-realtime@' + current.realtime_version,
		SCAFFOLD_EXTENSIONS_SPEC: 'svelte-adapter-uws-extensions@' + current.extensions_version,
		SCAFFOLD_UWS_SPEC: current.uwebsockets
	};
}

const SCAFFOLD_SPECS = { SCAFFOLD_ADAPTER_SPEC, SCAFFOLD_REALTIME_SPEC, SCAFFOLD_EXTENSIONS_SPEC, SCAFFOLD_UWS_SPEC };

/** The scaffolder installs exactly the manifest's current tuple. */
export function validateScaffold(current, specs = SCAFFOLD_SPECS) {
	const errors = [];
	for (const [name, expected] of Object.entries(expectedScaffoldSpecs(current))) {
		if (specs[name] !== expected) errors.push('src/cli-utils.js ' + name + ' is ' + JSON.stringify(specs[name]) + '; the manifest current tuple needs ' + JSON.stringify(expected) + ' (then run node scripts/generate-onboarding-reference.js --write)');
	}
	return errors;
}

/** The generated first-run transcript lists the same tuple. */
export function validateFirstRun(text, current) {
	const section = /^## Audited candidate tuple\n\n((?:- `[^`\n]+`\n)+)/m.exec(text.replace(/\r\n/g, '\n'));
	const listed = section ? section[1].trim().split('\n').map((item) => item.slice(3, -1)) : [];
	const expected = Object.values(expectedScaffoldSpecs(current));
	if (listed.length !== expected.length || listed.some((spec, index) => spec !== expected[index])) {
		return ['docs/first-run.md lists ' + (listed.join(', ') || 'no tuple') + '; the manifest current tuple is ' + expected.join(', ')];
	}
	return [];
}

const VERSION = '(\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?)';
// A release written next to the package name: `>= X`, `&gt;= X` (generated
// HTML), `@X`, `^X`, `vX`, or a bare `X` followed by any wording. A release
// newer than the tuple cannot be history, so every such mention is a
// requirement the tuple does not meet yet.
const ADAPTER_REQUIREMENT = new RegExp('svelte-adapter-uws`?(?:\\s*(?:>=|&gt;=)\\s*|@|\\s+)`?[\\^~]?v?' + VERSION + '(?![0-9A-Za-z-])', 'g');

/**
 * Adapter releases that documented features require beyond the current
 * tuple, grouped by version with the documents that state them. The README
 * names them next to the table, so the tuple never reads as running every
 * documented feature.
 */
export function aheadRequirements(documents, current) {
	const ahead = new Map();
	for (const [file, text] of documents) {
		for (const match of text.matchAll(ADAPTER_REQUIREMENT)) {
			const version = match[1];
			if (!semver.valid(version) || !semver.gt(version, current.adapter_version)) continue;
			if (!ahead.has(version)) ahead.set(version, new Set());
			ahead.get(version).add(file);
		}
	}
	return [...ahead].sort(([a], [b]) => semver.compare(a, b)).map(([version, files]) => ({ version, files: [...files].sort((a, b) => (a === 'README.md' ? -1 : b === 'README.md' ? 1 : a.localeCompare(b))) }));
}

function cell(value) {
	return '`' + value.replaceAll('|', '\\|') + '`';
}

function rowNotes(row) {
	const current = row.current === 'true';
	const label = row.channel[0].toUpperCase() + row.channel.slice(1);
	let notes = label + (current ? ' ' + row.train + (row.channel === 'prerelease' ? ' candidate' : ' release') : '') + '.';
	if (row.node) notes += ' Node ' + cell(row.node) + ' required.';
	if (current && row.channel === 'prerelease') notes += ' Publish the tuple together before these registry commands are used.';
	return notes;
}

function rowVersions(row) {
	if (row.current === 'true') return [row.adapter_version, row.realtime_version, row.extensions_version];
	const floor = row.realtime_adapter_floor || ADAPTER_FLOORS.get(row.train);
	return [floor ? '^' + floor : row.adapter, row.realtime, row.extensions];
}

/** Body of the README compatibility block: the table and the install commands. */
export function renderCompatibility(rows, ahead = []) {
	const current = currentRow(rows);
	const lines = [
		'| `svelte-adapter-uws` | `svelte-realtime` | `svelte-adapter-uws-extensions` | Notes |',
		'| --- | --- | --- | --- |',
		...rows.map((row) => '| ' + rowVersions(row).map(cell).join(' | ') + ' | ' + rowNotes(row) + ' |')
	];
	if (ahead.length) {
		const where = (file) => (file === 'README.md' ? 'this README' : '[' + file + '](./' + file + ')');
		lines.push('', 'Some documented features need a newer `svelte-adapter-uws` than this tuple: ' + ahead.map(({ version, files }) => cell(version) + ' (' + files.map(where).join(', ') + ')').join('; ') + '.');
	}
	lines.push(
		'',
		'Install the current ' + current.channel + ' tuple, the one the scaffolder installs, and run its native preflight:',
		'',
		'```bash',
		'npm install svelte-adapter-uws@' + current.adapter_version + ' svelte-realtime@' + current.realtime_version,
		'npm install ' + current.uwebsockets,
		'npm install -D ws',
		'npm exec -- svelte-adapter-uws-preflight',
		'```',
		''
	);
	return lines.join('\n');
}

/** Body of the Quick start block: the scaffolder command pinned to the current tuple. */
export function renderCli(rows) {
	const version = currentRow(rows).realtime_version;
	return [
		'```bash',
		'npx svelte-realtime@' + version + ' my-app --template example',
		'cd my-app',
		'npm run dev',
		'```',
		'',
		'For interactive prompts, run `npx svelte-realtime@' + version + ' my-app` in a terminal. Piped input and CI require both a project name and `--template minimal|example|demo`; missing values produce an immediate error with an example command.',
		''
	].join('\n');
}

export const BLOCKS = ['compatibility-cli', 'compatibility'];

export function blockBounds(text, name) {
	const start = '<!-- ' + name + ':start -->';
	const end = '<!-- ' + name + ':end -->';
	if (text.split(start).length !== 2 || text.split(end).length !== 2) throw new Error('README needs exactly one ' + name + ' start and end marker');
	const first = text.indexOf(start);
	const last = text.indexOf(end);
	if (last < first) throw new Error('README ' + name + ' markers are reversed');
	for (const [offset, marker] of [[first, start], [last, end]]) {
		if ((offset > 0 && text[offset - 1] !== '\n') || (offset + marker.length < text.length && text[offset + marker.length] !== '\n')) {
			throw new Error('README ' + name + ' markers must occupy complete lines');
		}
	}
	return { inner: first + start.length, end: last, outerEnd: last + end.length, first };
}

export function renderReadme(readme, rows, ahead = []) {
	const bodies = { 'compatibility-cli': renderCli(rows), compatibility: renderCompatibility(rows, ahead) };
	for (const name of BLOCKS) {
		const { inner, end } = blockBounds(readme, name);
		readme = readme.slice(0, inner) + '\n' + bodies[name] + readme.slice(end);
	}
	return readme;
}

/** The README with both generated blocks removed. */
export function outsideBlocks(readme) {
	for (const name of BLOCKS) {
		const { first, outerEnd } = blockBounds(readme, name);
		readme = readme.slice(0, first) + readme.slice(outerEnd);
	}
	return readme;
}

const UNBOUNDED = [
	[/\b(?:svelte-realtime|svelte-adapter-uws(?:-extensions)?)@(?:[\w^~<>=*-]|\.(?=[\w*]))+/g, 'a pinned ecosystem package'],
	// A bare tag (`@next`), not a scoped package (`@next/env`) or another
	// package's tag (`@sveltejs/kit@next`).
	[/(?<![\w/@.-])@(?:latest|next)\b(?![\w/-])/g, 'a moving dist-tag'],
	[/\b(?:npm\s+(?:install|i|add|create|init|exec)|pnpm\s+(?:add|install|dlx|create)|yarn\s+(?:add|dlx|create)|bun\s+add|bunx|npx)\b[^\n`]*?\bsvelte-(?:realtime|adapter-uws)\b/g, 'an ecosystem install command'],
	[/uNetworking\/uWebSockets\.js(?:#|\/archive\/)/g, 'a uWebSockets.js install source']
];

/** Install instructions for the ecosystem belong in the generated blocks only. */
export function validateUnboundedPins(readme) {
	// Join shell continuation lines so a command split across lines is still one command.
	const outside = outsideBlocks(readme).replace(/(?:\\|\^|`)\r?\n/g, '');
	const errors = [];
	for (const [pattern, kind] of UNBOUNDED) {
		const found = outside.match(pattern);
		if (found) errors.push('README states ' + kind + ' outside the generated compatibility blocks: ' + [...new Set(found)].join(', '));
	}
	return errors;
}

export function applyStatements(file, source, current, rows = []) {
	for (const statement of STATEMENTS) {
		if (statement.file !== file) continue;
		const matches = [...source.matchAll(new RegExp(statement.pattern.source, 'gd'))];
		if (matches.length !== 1) throw new Error(file + ' needs exactly one statement matching ' + statement.pattern + '; found ' + matches.length);
		const [from, to] = matches[0].indices[1];
		source = source.slice(0, from) + statement.value(current, rows) + source.slice(to);
	}
	return source;
}

function readText(directory, path) {
	return readFileSync(resolve(directory, path), 'utf8').replace(/\r\n/g, '\n');
}

/** README outside the generated blocks, the migration guide and every top-level docs page. */
export function requirementDocuments(directory, readme) {
	const docs = readdirSync(resolve(directory, 'docs')).filter((name) => name.endsWith('.md')).sort();
	const migration = existsSync(resolve(directory, 'MIGRATION.md')) ? [['MIGRATION.md', readText(directory, 'MIGRATION.md')]] : [];
	return [['README.md', outsideBlocks(readme)], ...migration, ...docs.map((name) => ['docs/' + name, readText(directory, 'docs/' + name)])];
}

/** Read and validate the installed adapter's manifest. */
export function loadManifest(directory = root) {
	const path = resolve(directory, MANIFEST_PATH);
	if (!existsSync(path)) {
		throw new Error('The svelte-adapter-uws compatibility manifest is missing at ' + MANIFEST_PATH + '. Run npm ci so the locked adapter is installed; an adapter release without docs/compatibility.v1.csv cannot back the documented tuple.');
	}
	const rows = parseManifest(readFileSync(path, 'utf8'));
	return { rows, current: currentRow(rows) };
}

export function checkCompatibility(directory = root, { write = false, release = false } = {}) {
	const { rows, current } = loadManifest(directory);
	const pkg = JSON.parse(readFileSync(resolve(directory, 'package.json'), 'utf8'));
	const adapter = JSON.parse(readFileSync(resolve(directory, ADAPTER_PACKAGE_PATH), 'utf8'));
	const errors = [
		...validatePackage(pkg, current, { release }),
		...validateInstalledAdapter(adapter, current),
		...validateScaffold(current),
		...validateFirstRun(readText(directory, 'docs/first-run.md'), current)
	];
	const readme = readText(directory, 'README.md');
	const ahead = aheadRequirements(requirementDocuments(directory, readme), current);
	if (release && ahead.length) errors.push('Documented features need svelte-adapter-uws ' + ahead.map(({ version }) => version).join(', ') + ', beyond the manifest tuple ' + current.adapter_version);
	// Render every file before writing any, so a missing marker or statement
	// leaves the tree untouched instead of half rewritten.
	const stale = [];
	for (const file of ['README.md', UPGRADE_GUIDE]) {
		const source = file === 'README.md' ? readme : readText(directory, file);
		let expected = file === 'README.md' ? renderReadme(source, rows, ahead) : source;
		expected = applyStatements(file, expected, current, rows);
		if (file === 'README.md') errors.push(...validateUnboundedPins(expected));
		if (expected !== source) stale.push({ file, expected });
	}
	if (errors.length) throw new Error(errors.join('\n'));
	if (write) for (const { file, expected } of stale) writeFileSync(resolve(directory, file), expected);
	else if (stale.length) throw new Error(stale.map(({ file }) => file).join(', ') + ' compatibility content is stale; run node scripts/check-compatibility.js --write');
	return { current, ahead, written: write ? stale.map(({ file }) => file) : [] };
}

if (isScriptEntry(import.meta.url)) {
	try {
		const release = process.argv.includes('--release');
		const { current } = checkCompatibility(root, { write: process.argv.includes('--write'), release });
		console.log('check-compatibility: README, scaffolder, first-run, restated floors and package floors match svelte-adapter-uws ' + current.adapter_version + ' manifest' + (release ? '; release version matches' : ''));
	} catch (error) {
		console.error(error.message);
		process.exitCode = 1;
	}
}
