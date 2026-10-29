#!/usr/bin/env node
// Generate and validate the documented ecosystem tuple from the compatibility
// manifest the installed svelte-adapter-uws ships. The README table, install
// commands and quick start pin are bounded generated blocks; the package
// floors, Node engine, scaffolder tuple, first-run transcript and upgrade
// guide statements must agree with the manifest's current row.
//
// --write rewrites only the bounded README blocks and the upgrade guide
// statements. --release additionally requires this package's version to be
// the realtime release the manifest declares; during development the version
// may run ahead of the published adapter, so the normal check only requires
// it to stay inside the declared series.
import { isScriptEntry } from './script-entry.js';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
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
	'extensions_version', 'realtime_head', 'extensions_head', 'wire_protocol', 'procedure'
];
const CHANNELS = ['legacy', 'stable', 'prerelease'];
const EXACT_VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const SERIES = /^\d+\.\d+\.(?:x|\d+(?:-[0-9A-Za-z.-]+)?)$/;
const UWS_SPEC = /^(?:https:\/\/github\.com\/uNetworking\/uWebSockets\.js\/archive\/refs\/tags\/v\d+\.\d+\.\d+\.tar\.gz|github:uNetworking\/uWebSockets\.js#v\d+\.\d+\.\d+)$/;
const NODE_FLOOR = /^>=\s*(\d+)(?:\.\d+){0,2}$/;

// The manifest records the series of each train, not the adapter release a
// svelte-realtime train requires. svelte-realtime 0.5.x declares
// svelte-adapter-uws ^0.5.11 as its peer, so the README states that floor on
// the 0.5 row instead of the bare series.
export const ADAPTER_FLOORS = new Map([['0.5', '0.5.11']]);

export const UPGRADE_GUIDE = 'docs/0.6-upgrade.md';
// Prose that restates manifest facts. Each pattern must match exactly once in
// its file with the stated value in group 1, so a reworded or deleted
// statement fails the check instead of silently escaping it.
export const STATEMENTS = [
	{ file: UPGRADE_GUIDE, pattern: /sibling packages\s+require Node (\d+) or newer/g, value: (current) => nodeMajor(current.node) },
	{ file: UPGRADE_GUIDE, pattern: /`svelte-adapter-uws`\s+`\^([^`]+)` as a peer/g, value: (current) => current.adapter_version },
	{ file: UPGRADE_GUIDE, pattern: /\| `0\.5\.x` \((\d+\.\d+\.\d+) or later\) \|/g, value: () => ADAPTER_FLOORS.get('0.5') },
	{ file: UPGRADE_GUIDE, pattern: /\| matching `([^`]+)`, at least `[^`]+` \|/g, value: (current) => current.adapter },
	{ file: UPGRADE_GUIDE, pattern: /\| matching `[^`]+`, at least `([^`]+)` \|/g, value: (current) => current.adapter_version },
	{ file: 'README.md', pattern: /the pinned native server supports Node (\d+) or newer/g, value: (current) => nodeMajor(current.node) }
];

export function nodeMajor(range) {
	const match = NODE_FLOOR.exec(range);
	if (!match) throw new Error('Node prerequisite ' + JSON.stringify(range) + ' is not a plain >= floor the documented Node statements can express');
	return match[1];
}

/**
 * Parse the manifest CSV (RFC 4180 quoting) and require the adapter's exact
 * v1 header, so a renamed, dropped or duplicated column fails here instead of
 * rendering a blank or `undefined` cell.
 */
export function parseManifest(text) {
	if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
	const records = [];
	let record = [];
	let field = '';
	let quoted = false;
	let closed = false;
	let line = 1;
	let opened = 1;
	for (let i = 0; i <= text.length; i++) {
		const char = text[i];
		if (quoted) {
			if (char === undefined) throw new Error('Compatibility manifest has an unclosed quoted field starting on line ' + opened);
			if (char === '"' && text[i + 1] === '"') { field += '"'; i++; }
			else if (char === '"') { quoted = false; closed = true; }
			else { if (char === '\n') line++; field += char; }
			continue;
		}
		if (char === ',' || char === '\n' || char === '\r' || char === undefined) {
			if (char === '\r' && text[i + 1] === '\n') i++;
			record.push(field);
			field = '';
			closed = false;
			if (char !== ',') {
				if (record.length > 1 || record[0] !== '') records.push({ line, values: record });
				record = [];
				line++;
			}
		} else if (closed) {
			throw new Error('Compatibility manifest has text after a closing quote on line ' + line);
		} else if (char === '"') {
			if (field !== '') throw new Error('Compatibility manifest has a quote inside an unquoted field on line ' + line);
			quoted = true;
			opened = line;
		} else field += char;
	}
	if (!records.length) throw new Error('Compatibility manifest is empty');
	const headers = records.shift().values;
	const duplicates = headers.filter((header, index) => headers.indexOf(header) !== index);
	const missing = EXPECTED_HEADERS.filter((header) => !headers.includes(header));
	const unexpected = headers.filter((header) => !EXPECTED_HEADERS.includes(header));
	if (duplicates.length || missing.length || unexpected.length || headers.some((header, index) => header !== EXPECTED_HEADERS[index])) {
		const detail = [
			duplicates.length && 'duplicate ' + [...new Set(duplicates)].join(', '),
			missing.length && 'missing ' + missing.join(', '),
			unexpected.length && 'unexpected ' + unexpected.join(', ')
		].filter(Boolean).join('; ') || 'columns out of order';
		throw new Error('Compatibility manifest header must be exactly ' + EXPECTED_HEADERS.join(',') + ' (' + detail + ')');
	}
	return records.map(({ line: at, values }) => {
		if (values.length !== headers.length) throw new Error('Compatibility manifest line ' + at + ' has ' + values.length + ' fields; expected ' + headers.length);
		return Object.fromEntries(headers.map((header, index) => [header, values[index]]));
	});
}

/** Schema and row-shape failures, mirroring the adapter's own manifest gate. */
export function validateRows(rows) {
	const errors = [];
	if (rows.length !== CHANNELS.length || rows.some((row, index) => row.channel !== CHANNELS[index])) {
		errors.push('Compatibility manifest channels must be exactly ' + CHANNELS.join(', ') + ' in that order');
	}
	for (const row of rows) {
		const label = row.channel || 'unnamed row';
		if (row.schema_version !== '1') errors.push(label + ': unsupported schema_version ' + JSON.stringify(row.schema_version));
		if (row.owner !== 'svelte-adapter-uws') errors.push(label + ': owner must be svelte-adapter-uws');
		if (row.current !== 'true' && row.current !== 'false') errors.push(label + ': current must be true or false');
		for (const [field, value] of Object.entries(row)) {
			if (/[\u0000-\u001f\u007f\u2028\u2029`|<]/.test(value)) errors.push(label + ': ' + field + ' must be a single printable line without Markdown control characters');
		}
		for (const field of ['adapter', 'realtime', 'extensions']) if (!SERIES.test(row[field])) errors.push(label + ': invalid ' + field + ' series');
		if (!/^\d+\.\d+$/.test(row.train)) errors.push(label + ': train must be a major.minor release train');
	}
	const current = rows.filter((row) => row.current === 'true');
	if (current.length !== 1) errors.push('Compatibility manifest needs exactly one current row; found ' + current.length);
	else {
		const row = current[0];
		for (const field of ['adapter_version', 'realtime_version', 'extensions_version']) {
			if (!EXACT_VERSION.test(row[field])) errors.push('current row needs an exact ' + field);
		}
		if (!row.node) errors.push('current row needs a Node prerequisite');
		if (!UWS_SPEC.test(row.uwebsockets)) errors.push('current row must name an exact tagged uWebSockets.js source');
	}
	for (const [train, floor] of ADAPTER_FLOORS) {
		const row = rows.find((candidate) => candidate.train === train && candidate.current === 'false');
		if (!row) errors.push('adapter floor ' + floor + ' names train ' + train + ', which has no non-current manifest row; remove it from ADAPTER_FLOORS');
		else if (!EXACT_VERSION.test(floor) || !matchesSeries(floor, row.adapter)) errors.push('adapter floor ' + floor + ' is outside the ' + train + ' adapter series ' + row.adapter);
	}
	return errors;
}

export function currentRow(rows) {
	const errors = validateRows(rows);
	if (errors.length) throw new Error(errors.join('\n'));
	return rows.find((row) => row.current === 'true');
}

function matchesSeries(version, series) {
	if (series.endsWith('.x')) return version.startsWith(series.slice(0, -1));
	return version === series || version.startsWith(series + '.');
}

export function validatePackage(pkg, current, { release = false } = {}) {
	const errors = [];
	if (pkg.engines?.node !== current.node) errors.push('package.json engines.node ' + JSON.stringify(pkg.engines?.node) + ' differs from the manifest Node prerequisite ' + current.node);
	if (pkg.peerDependencies?.['svelte-adapter-uws'] !== '^' + current.adapter_version) errors.push('Adapter peer floor ' + JSON.stringify(pkg.peerDependencies?.['svelte-adapter-uws']) + ' differs from the manifest; expected ^' + current.adapter_version);
	if (pkg.devDependencies?.['svelte-adapter-uws-extensions'] !== '^' + current.extensions_version) errors.push('Extensions development floor ' + JSON.stringify(pkg.devDependencies?.['svelte-adapter-uws-extensions']) + ' differs from the manifest; expected ^' + current.extensions_version);
	if (release) {
		if (pkg.version !== current.realtime_version) errors.push('Publishing ' + pkg.version + ' but the manifest declares svelte-realtime ' + current.realtime_version + '; install the adapter release that declares this version first');
	} else if (!matchesSeries(pkg.version, current.realtime)) {
		errors.push('package version ' + pkg.version + ' is outside the manifest realtime series ' + current.realtime);
	}
	return errors;
}

export function validateInstalledAdapter(adapter, current) {
	const errors = [];
	if (adapter.version !== current.adapter_version) errors.push('Installed svelte-adapter-uws ' + adapter.version + ' is not the manifest current adapter ' + current.adapter_version + '; reinstall dependencies');
	if (adapter.optionalDependencies?.['uWebSockets.js'] !== current.uwebsockets) errors.push('Installed adapter native pin differs from the manifest uwebsockets value');
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

function channelLabel(row) {
	return row.channel[0].toUpperCase() + row.channel.slice(1);
}

function rowNotes(row) {
	const current = row.current === 'true';
	let notes = channelLabel(row) + (current ? ' ' + row.train + (row.channel === 'prerelease' ? ' candidate' : ' release') : '') + '.';
	if (row.node) notes += ' Node ' + row.node + ' required.';
	if (current && row.channel === 'prerelease') notes += ' Publish the tuple together before these registry commands are used.';
	return notes;
}

function rowVersions(row) {
	if (row.current === 'true') return [row.adapter_version, row.realtime_version, row.extensions_version];
	const floor = ADAPTER_FLOORS.get(row.train);
	return [floor ? '^' + floor : row.adapter, row.realtime, row.extensions];
}

/** Body of the README compatibility block: the table and the install commands. */
export function renderCompatibility(rows) {
	const current = currentRow(rows);
	return [
		'| `svelte-adapter-uws` | `svelte-realtime` | `svelte-adapter-uws-extensions` | Notes |',
		'| --- | --- | --- | --- |',
		...rows.map((row) => '| ' + rowVersions(row).map((value) => '`' + value + '`').join(' | ') + ' | ' + rowNotes(row) + ' |'),
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
	].join('\n');
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

export const BLOCKS = { 'compatibility-cli': renderCli, compatibility: renderCompatibility };

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

export function renderReadme(readme, rows) {
	for (const [name, render] of Object.entries(BLOCKS)) {
		const { inner, end } = blockBounds(readme, name);
		readme = readme.slice(0, inner) + '\n' + render(rows) + readme.slice(end);
	}
	return readme;
}

const ECOSYSTEM_PIN = /\b(?:svelte-realtime|svelte-adapter-uws(?:-extensions)?)@\^?\d/g;

/** Exact ecosystem install pins belong in the generated blocks only. */
export function validateUnboundedPins(readme) {
	let outside = readme;
	for (const name of Object.keys(BLOCKS)) {
		const { first, outerEnd } = blockBounds(outside, name);
		outside = outside.slice(0, first) + outside.slice(outerEnd);
	}
	const pins = outside.match(ECOSYSTEM_PIN) || [];
	return pins.length ? ['README pins ' + [...new Set(pins)].join(', ') + ' outside the generated compatibility blocks'] : [];
}

export function applyStatements(file, source, current) {
	for (const statement of STATEMENTS) {
		if (statement.file !== file) continue;
		const matches = [...source.matchAll(new RegExp(statement.pattern.source, 'gd'))];
		if (matches.length !== 1) throw new Error(file + ' needs exactly one statement matching ' + statement.pattern + '; found ' + matches.length);
		const [from, to] = matches[0].indices[1];
		source = source.slice(0, from) + statement.value(current) + source.slice(to);
	}
	return source;
}

function readText(directory, path) {
	return readFileSync(resolve(directory, path), 'utf8').replace(/\r\n/g, '\n');
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
	// Render every file before writing any, so a missing marker or statement
	// leaves the tree untouched instead of half rewritten.
	const stale = [];
	for (const file of ['README.md', UPGRADE_GUIDE]) {
		const source = readText(directory, file);
		let expected = file === 'README.md' ? renderReadme(source, rows) : source;
		expected = applyStatements(file, expected, current);
		if (file === 'README.md') errors.push(...validateUnboundedPins(expected));
		if (expected !== source) stale.push({ file, expected });
	}
	if (errors.length) throw new Error(errors.join('\n'));
	if (write) for (const { file, expected } of stale) writeFileSync(resolve(directory, file), expected);
	else if (stale.length) throw new Error(stale.map(({ file }) => file).join(', ') + ' compatibility content is stale; run node scripts/check-compatibility.js --write');
	return { current, written: write ? stale.map(({ file }) => file) : [] };
}

if (isScriptEntry(import.meta.url)) {
	try {
		const release = process.argv.includes('--release');
		const { current } = checkCompatibility(root, { write: process.argv.includes('--write'), release });
		console.log('check-compatibility: README, scaffolder, first-run, upgrade guide and package floors match svelte-adapter-uws ' + current.adapter_version + ' manifest' + (release ? '; release version matches' : ''));
	} catch (error) {
		console.error(error.message);
		process.exitCode = 1;
	}
}
