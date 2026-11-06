import { describe, it, expect } from 'vitest';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	ADAPTER_FLOORS,
	EXPECTED_HEADERS,
	MANIFEST_PATH,
	UPGRADE_GUIDE,
	aheadRequirements,
	applyStatements,
	blockBounds,
	checkCompatibility,
	currentRow,
	expectedScaffoldSpecs,
	inRealtimeSeries,
	loadManifest,
	nodeRequirement,
	parseManifest,
	renderCli,
	renderCompatibility,
	renderReadme,
	requirementDocuments,
	validateFirstRun,
	validateInstalledAdapter,
	validatePackage,
	validateRows,
	validateScaffold,
	validateUnboundedPins
} from '../scripts/check-compatibility.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (path) => readFileSync(new URL('../' + path, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const manifestText = read(MANIFEST_PATH);
const { rows, current } = loadManifest();
const pkg = JSON.parse(read('package.json'));
const adapter = JSON.parse(read('node_modules/svelte-adapter-uws/package.json'));
const readme = read('README.md');
const upgrade = read(UPGRADE_GUIDE);
const firstRun = read('docs/first-run.md');
const documentedAhead = aheadRequirements(requirementDocuments(root, readme), current);

function csv(records) {
	return [EXPECTED_HEADERS.join(','), ...records.map((row) => EXPECTED_HEADERS.map((header) => row[header] ?? '').join(','))].join('\n') + '\n';
}
const inner = (text, name) => {
	const { inner: from, end } = blockBounds(text, name);
	return text.slice(from, end);
};
const withCurrent = (changes) => rows.map((row) => (row.current === 'true' ? { ...row, ...changes } : { ...row }));

function withFixture(run) {
	const directory = mkdtempSync(join(tmpdir(), 'realtime-compatibility-'));
	try {
		mkdirSync(join(directory, 'node_modules/svelte-adapter-uws/docs'), { recursive: true });
		mkdirSync(join(directory, 'docs'), { recursive: true });
		// Every top-level docs page, because documented adapter requirements are read from all of them.
		const docs = readdirSync(join(root, 'docs')).filter((name) => name.endsWith('.md')).map((name) => 'docs/' + name);
		for (const file of ['package.json', 'README.md', 'MIGRATION.md', ...docs, MANIFEST_PATH, 'node_modules/svelte-adapter-uws/package.json']) {
			copyFileSync(new URL('../' + file, import.meta.url), join(directory, file));
		}
		return run(directory, (file) => readFileSync(join(directory, file), 'utf8'), (file, text) => writeFileSync(join(directory, file), text));
	} finally {
		const target = resolve(directory);
		if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('realtime-compatibility-')) throw new Error('Unsafe temporary cleanup');
		rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	}
}

describe('README blocks generated from the adapter manifest', () => {
	it('holds exactly the rendered table, install commands and Quick start pin', () => {
		expect(inner(readme, 'compatibility')).toBe('\n' + renderCompatibility(rows, documentedAhead));
		expect(inner(readme, 'compatibility-cli')).toBe('\n' + renderCli(rows));
		const table = renderCompatibility(rows);
		expect(table).toContain('| `' + current.adapter_version + '` | `' + current.realtime_version + '` | `' + current.extensions_version + '` |');
		expect(table).toContain('npm install svelte-adapter-uws@' + current.adapter_version + ' svelte-realtime@' + current.realtime_version + '\n');
		expect(table).toContain('npm install ' + current.uwebsockets + '\n');
		expect(renderCli(rows)).toContain('npx svelte-realtime@' + current.realtime_version + ' my-app --template example\n');
		expect(renderCli(rows)).toContain('run `npx svelte-realtime@' + current.realtime_version + ' my-app` in a terminal');
		expect(() => checkCompatibility()).not.toThrow();
	});

	it('moves the Quick start pin and the table together when the manifest moves', () => {
		const moved = withCurrent({ realtime_version: '0.6.0-next.999', adapter_version: '0.6.0-next.998' });
		const rendered = renderReadme(readme, moved);
		const quickStart = inner(rendered, 'compatibility-cli');
		expect(quickStart).toContain('npx svelte-realtime@0.6.0-next.999 my-app --template example');
		expect(quickStart).toContain('`npx svelte-realtime@0.6.0-next.999 my-app`');
		expect(quickStart).not.toContain(current.realtime_version);
		expect(inner(rendered, 'compatibility')).toContain('npm install svelte-adapter-uws@0.6.0-next.998 svelte-realtime@0.6.0-next.999');
		// Only the two blocks change.
		const outside = (text) => ['compatibility-cli', 'compatibility'].reduce((rest, name) => {
			const { first, outerEnd } = blockBounds(rest, name);
			return rest.slice(0, first) + rest.slice(outerEnd);
		}, text);
		expect(outside(rendered)).toBe(outside(readme));
	});

	it('labels rows from the channel column once the current row is the stable release', () => {
		const facts = Object.fromEntries(['realtime_head', 'extensions_head', 'wire_protocol', 'procedure', 'sveltekit'].map((field) => [field, current[field]]));
		const floors = (version) => ({ realtime_adapter_floor: version, extensions_adapter_floor: version });
		const promoted = parseManifest(csv([
			{ schema_version: '1', owner: 'svelte-adapter-uws', current: 'false', channel: 'legacy', adapter: '0.5.x', realtime: '0.5.x', extensions: '0.5.x', train: '0.5' },
			{ schema_version: '1', owner: 'svelte-adapter-uws', current: 'true', channel: 'stable', dist_tag: 'latest', adapter_version: '0.6.0', provenance: 'workspace', adapter: '0.6.x', realtime: '0.6.x', extensions: '0.6.x', node: '>=22.0.0', uwebsockets: current.uwebsockets, train: '0.6', realtime_version: '0.6.0', extensions_version: '0.6.0', ...facts, ...floors('0.6.0') },
			{ schema_version: '1', owner: 'svelte-adapter-uws', current: 'false', channel: 'prerelease', dist_tag: 'next', adapter_version: '0.7.0-next.1', provenance: 'npm:svelte-adapter-uws@0.7.0-next.1', adapter: '0.7.0-next', realtime: '0.7.0-next', extensions: '0.7.0-next', node: '>=22.0.0', uwebsockets: current.uwebsockets, train: '0.7', ...floors('0.7.0-next.1') }
		]));
		expect(validateRows(promoted)).toEqual([]);
		const table = renderCompatibility(promoted);
		expect(table).toContain('| `^' + ADAPTER_FLOORS.get('0.5') + '` | `0.5.x` | `0.5.x` | Legacy. |');
		expect(table).toContain('| `0.6.0` | `0.6.0` | `0.6.0` | Stable 0.6 release. Node `>=22.0.0` required. |');
		expect(table).toContain('| `^0.7.0-next.1` | `0.7.0-next` | `0.7.0-next` | Prerelease. Node `>=22.0.0` required. |');
		expect(table).toContain('Install the current stable tuple');
		expect(table).not.toMatch(/candidate|Publish the tuple together|newer `svelte-adapter-uws`/);
		// The stable cut of the prerelease series this package develops on stays in series.
		expect(validatePackage({ ...pkg, version: '0.6.0' }, current)).toEqual([]);
	});

	it('keeps the 0.5 adapter floor this package declares instead of the bare series', () => {
		const stable = rows.find((row) => row.train === '0.5');
		expect(stable.adapter).toBe('0.5.x');
		expect(renderCompatibility(rows)).toContain('| `^0.5.11` | `0.5.x` | `0.5.x` |');
		const dropped = rows.map((row) => (row.train === '0.5' ? { ...row, train: '0.4', adapter: '0.4.x', realtime: '0.4.x', extensions: '0.4.x', adapter_version: '0.4.9', provenance: 'npm:svelte-adapter-uws@0.4.9', realtime_adapter_floor: '0.4.9', extensions_adapter_floor: '0.4.9' } : row));
		expect(validateRows(dropped)).toEqual(['the manifest no longer lists the 0.5 train; remove it from ADAPTER_FLOORS']);
		const moved = rows.map((row) => (row.train === '0.5' ? { ...row, adapter: '0.5.1' } : row));
		expect(validateRows(moved).join('\n')).toContain('adapter floor 0.5.11 is not an exact release inside the 0.5 adapter series 0.5.1');
		// A row that carries the floor column is rendered from it.
		const raised = rows.map((row) => (row.train === '0.5' ? { ...row, realtime_adapter_floor: '0.5.12' } : row));
		expect(validateRows(raised)).toEqual([]);
		expect(renderCompatibility(raised)).toContain('| `^0.5.12` | `0.5.x` | `0.5.x` |');
	});

	it('names adapter releases that documented features need beyond the tuple', () => {
		const next = (n) => current.adapter_version.replace(/\d+$/, (value) => String(Number(value) + n));
		const documents = [
			['docs/b.md', 'Needs `svelte-adapter-uws` `' + next(2) + '` or newer.'],
			['README.md', 'Requires svelte-adapter-uws >= ' + next(1) + '.'],
			['docs/a.md', 'svelte-adapter-uws >= ' + next(2) + ' and svelte-adapter-uws >= ' + current.adapter_version + ' and svelte-adapter-uws 0.5.0 or later']
		];
		expect(aheadRequirements(documents, current)).toEqual([
			{ version: next(1), files: ['README.md'] },
			{ version: next(2), files: ['docs/a.md', 'docs/b.md'] }
		]);
		const rendered = renderCompatibility(rows, aheadRequirements(documents, current));
		expect(rendered).toContain('Some documented features need a newer `svelte-adapter-uws` than this tuple: `' + next(1) + '` (this README); `' + next(2) + '` ([docs/a.md](./docs/a.md), [docs/b.md](./docs/b.md)).');
	});

	it.each([
		['generated HTML', 'requires svelte-adapter-uws &gt;= {v}).'],
		['an npm spec', 'install `svelte-adapter-uws@{v}` or newer'],
		['a caret range', '`svelte-adapter-uws` `^{v}`'],
		['a v prefix', 'svelte-adapter-uws v{v} or higher'],
		['a bare release', 'Requires svelte-adapter-uws {v}.']
	])('reads an adapter requirement written as %s', (_, template) => {
		const version = current.adapter_version.replace(/\d+$/, (n) => String(Number(n) + 3));
		expect(aheadRequirements([['docs/x.md', template.replace('{v}', version)]], current)).toEqual([{ version, files: ['docs/x.md'] }]);
		expect(aheadRequirements([['docs/x.md', template.replace('{v}', version + '0-')]], current).map(({ version: found }) => found)).not.toContain(version);
	});

	it('scans the migration guide for adapter requirements', () => {
		withFixture((directory, get, put) => {
			const newer = current.adapter_version.replace(/\d+$/, (n) => String(Number(n) + 7));
			put('MIGRATION.md', get('MIGRATION.md') + '\nThis step needs svelte-adapter-uws >= ' + newer + '.\n');
			expect(aheadRequirements(requirementDocuments(directory, get('README.md')), current).at(-1)).toEqual({ version: newer, files: ['MIGRATION.md'] });
		});
	});

	it('states the Node floor as prose only for a plain lower bound', () => {
		expect(nodeRequirement('>=22.0.0')).toBe('Node 22 or newer');
		expect(nodeRequirement('>=22.12.0')).toBe('Node 22.12 or newer');
		expect(nodeRequirement('>=22.12.3')).toBe('Node 22.12.3 or newer');
		expect(nodeRequirement('^22.12.0 || >=24.0.0')).toBe('a Node version in `^22.12.0 || >=24.0.0`');
		expect(nodeRequirement('>=24.0.0-rc.1')).toBe('a Node version in `>=24.0.0-rc.1`');
	});

	it('counts the stable cut of a prerelease series as inside it', () => {
		expect(inRealtimeSeries('0.6.0-next.92', '0.6.0-next')).toBe(true);
		expect(inRealtimeSeries('0.6.0', '0.6.0-next')).toBe(true);
		expect(inRealtimeSeries('0.6.1', '0.6.0-next')).toBe(false);
		expect(inRealtimeSeries('0.6.0-rc.1', '0.6.0-next')).toBe(false);
		expect(inRealtimeSeries('0.5.16', '0.5.x')).toBe(true);
		expect(inRealtimeSeries('0.6.0', '0.5.x')).toBe(false);
	});

	it('rejects exact ecosystem pins outside the generated blocks', () => {
		expect(validateUnboundedPins(readme)).toEqual([]);
		const outside = (text) => readme.replace('## Manual setup\n', '## Manual setup\n\n' + text + '\n');
		expect(validateUnboundedPins(outside('Run `npx svelte-realtime@0.6.0-next.1 app`.'))).toEqual([
			'README states a pinned ecosystem package outside the generated compatibility blocks: svelte-realtime@0.6.0-next.1',
			'README states an ecosystem install command outside the generated compatibility blocks: npx svelte-realtime'
		]);
		expect(validateUnboundedPins(outside('Pin svelte-adapter-uws@0.6.0-next.2.'))).toEqual(['README states a pinned ecosystem package outside the generated compatibility blocks: svelte-adapter-uws@0.6.0-next.2']);
		expect(validateUnboundedPins(outside('Track the `@next` tag.')).join('\n')).toContain('a moving dist-tag outside the generated compatibility blocks: @next');
		expect(validateUnboundedPins(outside('Use `@sveltejs/kit@next` and `@next/env`, write to user@latest.example.'))).toEqual([]);
		for (const command of ['`pnpm add -D svelte-adapter-uws`', '`bunx svelte-realtime my-app`', '`pnpm dlx svelte-realtime my-app`', '`npm create svelte-realtime`', '`npm exec svelte-realtime`', '```bash\nnpm install \\\n  svelte-adapter-uws\n```']) {
			expect(validateUnboundedPins(outside(command)).join('\n')).toContain('an ecosystem install command');
		}
		expect(validateUnboundedPins(outside('`github:uNetworking/uWebSockets.js#v20.0.0`')).join('\n')).toContain('a uWebSockets.js install source');
		expect(validateUnboundedPins(outside('The svelte-realtime package and svelte-adapter-uws work together.'))).toEqual([]);
	});
});

describe('manifest parsing', () => {
	it('splits trimmed lines on plain commas exactly as the adapter does', () => {
		expect(parseManifest(manifestText)).toEqual(rows);
		const parsed = parseManifest('\ufeff' + csv(rows).replace(/\n/g, '\r\n') + '\r\n');
		expect(Object.keys(parsed[0])[0]).toBe('schema_version');
		expect(parsed).toEqual(rows);
		// Quotes carry no CSV meaning, so a quoted value stays literal and fails
		// validation, and a quoted comma still splits the row.
		const quoted = parseManifest(manifestText.replace(current.uwebsockets, '"' + current.uwebsockets + '"'));
		expect(currentRow.bind(null, quoted)).toThrow(/prerelease: uWebSockets\.js must be an exact tagged GitHub source/);
		expect(() => parseManifest(manifestText.replace(current.procedure, '"a,b"'))).toThrow(new RegExp('row 4 has ' + (EXPECTED_HEADERS.length + 1) + ' fields; expected ' + EXPECTED_HEADERS.length));
	});

	it('fails closed on missing, duplicated, extra and reordered columns', () => {
		const header = EXPECTED_HEADERS.join(',');
		const dropNode = manifestText.split('\n').map((line) => line.split(',').filter((_, index) => index !== EXPECTED_HEADERS.indexOf('node')).join(',')).join('\n');
		expect(() => parseManifest(dropNode)).toThrow(/missing node/);
		expect(() => parseManifest(manifestText.replace(header, header.replace('extensions_version', 'realtime_version')))).toThrow(/duplicate realtime_version; missing extensions_version/);
		expect(() => parseManifest(manifestText.replace(header, header + ',ecosystem_release'))).toThrow(/unexpected ecosystem_release/);
		expect(() => parseManifest(manifestText.replace(header, header.replace('adapter,realtime', 'realtime,adapter')))).toThrow(/columns out of order/);
		expect(() => parseManifest(manifestText.replace(',0.4,', ',0.4,,'))).toThrow(new RegExp('row 2 has ' + (EXPECTED_HEADERS.length + 1) + ' fields; expected ' + EXPECTED_HEADERS.length));
		expect(() => parseManifest('')).toThrow(/empty/);
	});

	it('validates schema version, owner, channels and the current row', () => {
		expect(validateRows(rows)).toEqual([]);
		expect(validateRows(rows.map((row) => ({ ...row, schema_version: '2' }))).join('\n')).toContain('unsupported schema_version');
		expect(validateRows(rows.map((row) => ({ ...row, owner: 'svelte-realtime' }))).join('\n')).toContain('owner must be svelte-adapter-uws');
		expect(validateRows(rows.map((row) => ({ ...row, current: 'false' }))).join('\n')).toContain('exactly one compatibility row must be current; found 0');
		expect(validateRows(rows.map((row) => ({ ...row, current: row.channel === 'legacy' ? 'true' : row.current }))).join('\n')).toContain('exactly one compatibility row must be current; found 2');
		expect(validateRows(rows.map((row) => ({ ...row, current: 'yes' }))).join('\n')).toContain('current must be true or false');
		expect(validateRows([rows[0], rows[2], rows[1]]).join('\n')).toContain('channels must be ordered legacy, stable, prerelease');
		expect(validateRows(rows.slice(1)).join('\n')).toContain('channels must be exactly legacy, stable, prerelease');
		expect(() => renderCompatibility(withCurrent({ current: 'false' }))).toThrow(/found 0/);
	});

	// One mutation per adapter manifest rule, each pinned to the message it must produce.
	const byChannel = (channel, changes) => rows.map((row) => (row.channel === channel ? { ...row, ...changes } : { ...row }));
	it.each([
		['a dist tag outside its channel role', byChannel('stable', { dist_tag: 'next' }), 'stable: invalid dist tag role'],
		['an invalid series', withCurrent({ realtime: '0.6.0-next|x' }), 'prerelease: invalid realtime series'],
		['a backtick in a value', withCurrent({ node: '>=22.0.0`' }), 'prerelease: node must be a single printable line'],
		['a loose Node range', withCurrent({ node: '>= 22 garbage' }), 'prerelease: node must be a canonical single-line npm semver range'],
		['release facts on the untagged legacy row', byChannel('legacy', { node: '>=22.0.0' }), 'legacy: untagged legacy channel must not claim release or runtime facts'],
		['an adapter release outside its series', byChannel('stable', { adapter_version: '0.6.0', provenance: 'npm:svelte-adapter-uws@0.6.0' }), 'stable: adapter release identity is outside its series'],
		['a moving native source', withCurrent({ uwebsockets: 'uWebSockets.js@latest' }), 'prerelease: uWebSockets.js must be an exact tagged GitHub source'],
		['an unpinned published baseline', byChannel('stable', { provenance: 'workspace' }), 'stable: published baseline provenance is not pinned'],
		['a train with a patch level', withCurrent({ train: '0.6.0' }), 'prerelease: train must be a major.minor release train'],
		['a train that does not prefix the series', withCurrent({ train: '0.7' }), 'prerelease: train 0.7 does not prefix the adapter series 0.6.0-next'],
		['a partial set of train facts', withCurrent({ extensions_version: '' }), 'prerelease: train release facts form one unit and must be all present or all empty'],
		['a current row without train facts', withCurrent(Object.fromEntries(['realtime_version', 'extensions_version', 'realtime_head', 'extensions_head', 'wire_protocol', 'procedure', 'sveltekit'].map((field) => [field, '']))), 'prerelease: current row must record every train release fact'],
		['a current row without its SvelteKit versions', withCurrent({ sveltekit: '' }), 'prerelease: train release facts form one unit and must be all present or all empty'],
		['SvelteKit versions out of order', withCurrent({ sveltekit: '3.0.1 2.70.2' }), 'prerelease: sveltekit must be space-separated exact SvelteKit versions in ascending order'],
		['a SvelteKit range instead of a version', withCurrent({ sveltekit: '^2.70.2' }), 'prerelease: sveltekit must be space-separated exact SvelteKit versions in ascending order'],
		['a repeated SvelteKit version', withCurrent({ sveltekit: '2.70.2 2.70.2' }), 'prerelease: sveltekit must be space-separated exact SvelteKit versions in ascending order'],
		['a SvelteKit version with a v prefix', withCurrent({ sveltekit: 'v2.70.2' }), 'prerelease: sveltekit must be space-separated exact SvelteKit versions in ascending order'],
		['an adapter floor that is not canonical', withCurrent({ extensions_adapter_floor: 'v' + current.adapter_version }), 'prerelease: extensions_adapter_floor must be an exact adapter release inside the series 0.6.0-next'],
		['adapter floors on the untagged legacy row', byChannel('legacy', { realtime_adapter_floor: '0.4.0' }), 'legacy: untagged legacy channel must not claim release or runtime facts'],
		['a tagged row without a realtime adapter floor', withCurrent({ realtime_adapter_floor: '' }), 'prerelease: realtime_adapter_floor must be an exact adapter release inside the series 0.6.0-next'],
		['an extensions adapter floor outside the series', withCurrent({ extensions_adapter_floor: '0.5.11' }), 'prerelease: extensions_adapter_floor must be an exact adapter release inside the series 0.6.0-next'],
		['an adapter floor above the row adapter release', withCurrent({ realtime_adapter_floor: '0.6.0-next.999' }), 'prerelease: realtime_adapter_floor 0.6.0-next.999 is above the row\'s adapter release ' + current.adapter_version],
		['an invalid adapter release beside valid floors', withCurrent({ adapter_version: 'next' }), 'prerelease: adapter release identity is outside its series'],
		['a realtime release outside its series', withCurrent({ realtime_version: '0.5.16' }), 'prerelease: realtime_version release identity is outside its series'],
		['an abbreviated git head', withCurrent({ extensions_head: current.extensions_head.slice(0, 12) }), 'prerelease: extensions_head must be a full lowercase git head'],
		['a zero wire protocol', withCurrent({ wire_protocol: '0' }), 'prerelease: wire_protocol must be a positive integer revision'],
		['a procedure outside docs/releasing.md', withCurrent({ procedure: 'docs/other.md#abort' }), 'prerelease: procedure must be space-separated docs/releasing.md anchors'],
		['a current row without workspace provenance', withCurrent({ provenance: 'npm:svelte-adapter-uws@' + current.adapter_version }), 'current channel provenance must be workspace'],
		['a sibling outside the lockstep series', withCurrent({ extensions: '0.6.1-next' }), 'prerelease: extensions series 0.6.1-next does not match the lockstep adapter series 0.6.0-next'],
		['a current stable release on the prerelease channel', withCurrent({ adapter: '0.6.x', realtime: '0.6.x', extensions: '0.6.x', adapter_version: '0.6.0', realtime_version: '0.6.0', extensions_version: '0.6.0' }), 'current channel does not match the adapter version stability']
	])('rejects %s', (_, mutated, message) => {
		expect(validateRows(mutated)).toContain(message);
	});
});

describe('agreement with package, scaffolder and docs', () => {
	it('compares engines.node and both package floors with the current row', () => {
		expect(validatePackage(pkg, current)).toEqual([]);
		const withPeer = (base, range) => ({ ...base, peerDependencies: { ...base.peerDependencies, 'svelte-adapter-uws': range } });
		// The release the row pairs with declares the caret range of the row's
		// floor, the range the upgrade guide states.
		const floor = current.realtime_adapter_floor;
		const paired = withPeer({ ...pkg, version: current.realtime_version }, '^' + floor);
		expect(validatePackage(paired, current)).toEqual([]);
		expect(validatePackage(paired, { ...current, realtime_adapter_floor: '0.6.0-next.96' })).toEqual(['Adapter peer floor "^' + floor + '" differs from the manifest realtime_adapter_floor; expected ^0.6.0-next.96']);
		expect(validatePackage(withPeer(paired, '>=' + floor), current).join('\n')).toContain('expected ^' + floor);
		expect(validatePackage(withPeer(paired, floor), current).join('\n')).toContain('expected ^' + floor);
		// An adapter-only release keeps the floor of the realtime release it pairs
		// with, and the range must admit the adapter the row installs it with.
		const next = current.adapter_version.replace(/\d+$/, (n) => String(Number(n) + 1));
		expect(validatePackage(paired, { ...current, adapter_version: next })).toEqual([]);
		expect(validatePackage(paired, { ...current, adapter_version: next }, { release: true })).toEqual([]);
		// npm's peer resolution: a prerelease of a later version is outside the range.
		expect(validatePackage(withPeer(paired, '^0.7.0-alpha.1'), { ...current, realtime_adapter_floor: '0.7.0-alpha.1', adapter_version: '0.7.1-next.0' })).toEqual(['Adapter peer ^0.7.0-alpha.1 does not admit the manifest adapter release 0.7.1-next.0']);
		expect(validatePackage(withPeer(paired, '^' + next), { ...current, adapter_version: next }, { release: true }).join('\n')).toContain('expected ^' + floor);
		expect(validatePackage(paired, { ...current, adapter_version: '0.6.0-next.1' })).toEqual(['Adapter peer ^' + floor + ' does not admit the manifest adapter release 0.6.0-next.1']);
		// A checkout at another version follows the current adapter, and a release
		// of a version the row does not declare is refused for its version alone.
		const ahead = withPeer({ ...pkg, version: current.realtime_version.replace(/\d+$/, (n) => String(Number(n) + 1)) }, '^' + current.adapter_version);
		expect(validatePackage(ahead, current)).toEqual([]);
		expect(validatePackage(ahead, { ...current, adapter_version: next }).join('\n')).toContain('expected ^' + next);
		const unpaired = validatePackage(ahead, { ...current, realtime_adapter_floor: '0.6.0-next.96' }, { release: true }).join('\n');
		expect(unpaired).toContain('Publishing ' + ahead.version);
		expect(unpaired).not.toContain('realtime_adapter_floor');
		expect(validatePackage({ ...pkg, engines: { node: '>=24.0.0' } }, current).join('\n')).toContain('engines.node');
		expect(validatePackage({ ...pkg, peerDependencies: { ...pkg.peerDependencies, 'svelte-adapter-uws': '^0.6.0-next.1' } }, current).join('\n')).toContain('Adapter peer floor');
		expect(validatePackage({ ...pkg, devDependencies: { ...pkg.devDependencies, 'svelte-adapter-uws-extensions': '^0.6.0-next.1' } }, current).join('\n')).toContain('Extensions development floor');
	});

	it('lets development run ahead of the manifest but releases only the declared version', () => {
		const ahead = { ...pkg, version: current.realtime_version.replace(/\d+$/, (n) => String(Number(n) + 1)) };
		expect(ahead.version).not.toBe(current.realtime_version);
		expect(validatePackage(ahead, current)).toEqual([]);
		expect(validatePackage(ahead, current, { release: true }).join('\n')).toContain('manifest declares svelte-realtime ' + current.realtime_version);
		expect(validatePackage({ ...pkg, version: current.realtime_version }, current, { release: true })).toEqual([]);
		expect(validatePackage({ ...pkg, version: '9.0.0' }, current).join('\n')).toContain('outside the manifest realtime series');
		expect(pkg.scripts.prepublishOnly.startsWith('node scripts/check-compatibility.js --release && ')).toBe(true);
		expect(pkg.scripts.check).toContain('node scripts/check-compatibility.js && ');
		expect(pkg.scripts.check).not.toContain('check-compatibility.js --release');
	});

	it('requires the scaffolder to install the manifest tuple', () => {
		const specs = expectedScaffoldSpecs(current);
		expect(validateScaffold(current)).toEqual([]);
		for (const name of Object.keys(specs)) {
			const drifted = { ...specs, [name]: specs[name] + '0' };
			expect(validateScaffold(current, drifted).join('\n')).toContain(name);
		}
	});

	it('requires docs/first-run.md to list the same tuple', () => {
		expect(validateFirstRun(firstRun, current)).toEqual([]);
		expect(validateFirstRun(firstRun.replace(current.extensions_version + '`', current.extensions_version + '0`'), current).join('\n')).toContain('docs/first-run.md lists');
		expect(validateFirstRun(firstRun.replace('## Audited candidate tuple', '## Tuple'), current).join('\n')).toContain('no tuple');
	});

	it('requires the installed adapter to be the manifest owner', () => {
		expect(validateInstalledAdapter(adapter, current)).toEqual([]);
		expect(validateInstalledAdapter({ ...adapter, version: '0.6.0-next.1' }, current).join('\n')).toContain('reinstall dependencies');
		expect(validateInstalledAdapter({ ...adapter, optionalDependencies: {} }, current).join('\n')).toContain('native pin');
		expect(validateInstalledAdapter({ ...adapter, engines: { node: '>=24.0.0' } }, current)).toEqual(['Installed adapter engines.node ">=24.0.0" differs from the manifest Node prerequisite ' + current.node]);
		expect(validateInstalledAdapter({ ...adapter, publishConfig: { tag: 'latest' } }, current)).toEqual(['Installed adapter publishConfig.tag "latest" differs from the manifest dist tag ' + current.dist_tag]);
	});

	it('generates the floors the upgrade guide states', () => {
		expect(applyStatements(UPGRADE_GUIDE, upgrade, current)).toBe(upgrade);
		const moved = { ...current, adapter_version: '0.6.0-next.501', realtime_adapter_floor: '0.6.0-next.500', adapter: '0.6.1-next', realtime: '0.6.1-next', extensions: '0.6.1-next' };
		const rendered = applyStatements(UPGRADE_GUIDE, upgrade, moved);
		expect(rendered).toContain('`svelte-adapter-uws`\n`^0.6.0-next.500` as a peer');
		expect(rendered).toContain('| exact `0.6.1-next.*` | matching `0.6.1-next`, at least `0.6.0-next.500` | matching `0.6.1-next` |');
		const promoted = applyStatements(UPGRADE_GUIDE, upgrade, { ...current, adapter_version: '0.6.0', realtime_adapter_floor: '0.6.0', adapter: '0.6.x', realtime: '0.6.x', extensions: '0.6.x' });
		expect(promoted).toContain('| exact `0.6.x` | matching `0.6.x`, at least `0.6.0` | matching `0.6.x` |');
		expect(applyStatements(UPGRADE_GUIDE, upgrade.replace('(0.5.11 or later)', '(0.5.8 or later)'), current)).toBe(upgrade);
		// The rollback floor comes from the same manifest column as the README row.
		expect(applyStatements(UPGRADE_GUIDE, upgrade, current, rows)).toBe(upgrade);
		const raised = rows.map((row) => (row.train === '0.5' ? { ...row, realtime_adapter_floor: '0.5.12' } : row));
		expect(applyStatements(UPGRADE_GUIDE, upgrade, current, raised)).toContain('| `0.5.x` (0.5.12 or later) |');
		expect(() => applyStatements(UPGRADE_GUIDE, upgrade.replace('as a peer', 'as peer'), current)).toThrow(/exactly one statement/);
	});
});

describe('check-compatibility entry point', () => {
	it('names the missing adapter manifest instead of failing with ENOENT', () => {
		withFixture((directory) => {
			rmSync(join(directory, MANIFEST_PATH));
			expect(() => checkCompatibility(directory)).toThrow(/compatibility manifest is missing at node_modules\/svelte-adapter-uws\/docs\/compatibility\.v1\.csv\. Run npm ci/);
		});
	});

	it('fails on column drift in the installed manifest', () => {
		withFixture((directory, get, put) => {
			put(MANIFEST_PATH, get(MANIFEST_PATH).replace('extensions_version,', 'extensions_release,'));
			expect(() => checkCompatibility(directory)).toThrow(/missing extensions_version; unexpected extensions_release/);
		});
	});

	it('gates the release version only under --release', () => {
		withFixture((directory, get, put) => {
			const next = JSON.parse(get('package.json'));
			next.version = current.realtime_version.replace(/\d+$/, (n) => String(Number(n) + 1));
			put('package.json', JSON.stringify(next, null, 2) + '\n');
			expect(() => checkCompatibility(directory)).not.toThrow();
			expect(() => checkCompatibility(directory, { release: true })).toThrow(/manifest declares svelte-realtime/);
		});
	});

	it('--write rewrites only the bounded blocks and stated floors, byte for byte', () => {
		withFixture((directory, get, put) => {
			const marked = readme.replace('## Manual setup\n', '## Manual setup\n\nUnrelated prose stays.\n');
			const stale = marked
				.replace('npx svelte-realtime@' + current.realtime_version + ' my-app --template', 'npx svelte-realtime@0.0.1 my-app --template')
				.replace('| `' + current.adapter_version + '` |', '| `0.0.2` |');
			const staleUpgrade = upgrade.replace('`^' + current.adapter_version + '` as a peer', '`^0.0.3` as a peer');
			expect(stale).not.toBe(marked);
			expect(staleUpgrade).not.toBe(upgrade);
			put('README.md', stale);
			put(UPGRADE_GUIDE, staleUpgrade);
			expect(() => checkCompatibility(directory)).toThrow(/README\.md, docs\/0\.6-upgrade\.md compatibility content is stale/);
			const { written } = checkCompatibility(directory, { write: true });
			expect(written).toEqual(['README.md', UPGRADE_GUIDE]);
			expect(get('README.md')).toBe(marked);
			expect(get(UPGRADE_GUIDE)).toBe(upgrade);
			expect(() => checkCompatibility(directory)).not.toThrow();
		});
	});

	it('writes nothing when any file cannot be rendered', () => {
		withFixture((directory, get, put) => {
			const staleReadme = readme.replace('| `' + current.adapter_version + '` |', '| `0.0.2` |');
			put('README.md', staleReadme);
			put(UPGRADE_GUIDE, upgrade.replace('as a peer', 'as peer'));
			expect(() => checkCompatibility(directory, { write: true })).toThrow(/exactly one statement/);
			expect(get('README.md')).toBe(staleReadme);
			put(UPGRADE_GUIDE, upgrade);
			put('README.md', readme.replace('<!-- compatibility-cli:end -->\n', ''));
			expect(() => checkCompatibility(directory, { write: true })).toThrow(/exactly one compatibility-cli start and end marker/);
		});
	});

	it('refuses a first-run transcript drift even when the README is current', () => {
		withFixture((directory, get, put) => {
			put('docs/first-run.md', get('docs/first-run.md').replace(current.adapter_version, '0.0.4'));
			expect(() => checkCompatibility(directory, { write: true })).toThrow(/docs\/first-run\.md lists/);
		});
	});

	it('refuses a scaffolder that installs another tuple than the manifest declares', () => {
		withFixture((directory, get, put) => {
			const bumped = current.extensions_version.replace(/\d+$/, (n) => String(Number(n) + 1));
			put(MANIFEST_PATH, get(MANIFEST_PATH).replace(',' + current.extensions_version + ',', ',' + bumped + ','));
			const next = JSON.parse(get('package.json'));
			next.devDependencies['svelte-adapter-uws-extensions'] = '^' + bumped;
			put('package.json', JSON.stringify(next, null, 2) + '\n');
			put('docs/first-run.md', get('docs/first-run.md').replace('svelte-adapter-uws-extensions@' + current.extensions_version, 'svelte-adapter-uws-extensions@' + bumped));
			let message = '';
			try { checkCompatibility(directory, { write: true }); } catch (error) { message = error.message; }
			expect(message).toBe('src/cli-utils.js SCAFFOLD_EXTENSIONS_SPEC is "svelte-adapter-uws-extensions@' + current.extensions_version + '"; the manifest current tuple needs "svelte-adapter-uws-extensions@' + bumped + '" (then run node scripts/generate-onboarding-reference.js --write)');
		});
	});

	it('refuses an exact ecosystem pin outside the generated blocks', () => {
		withFixture((directory, get, put) => {
			put('README.md', get('README.md').replace('## Manual setup\n', '## Manual setup\n\nRun `npm install svelte-adapter-uws@0.6.0-next.1`.\n'));
			expect(() => checkCompatibility(directory, { write: true })).toThrow(/a pinned ecosystem package outside the generated compatibility blocks: svelte-adapter-uws@0\.6\.0-next\.1$/m);
		});
	});

	it('refuses to release while documented features need a newer adapter than the tuple', () => {
		withFixture((directory, get, put) => {
			const next = JSON.parse(get('package.json'));
			next.version = current.realtime_version;
			put('package.json', JSON.stringify(next, null, 2) + '\n');
			const newer = current.adapter_version.replace(/\d+$/, (n) => String(Number(n) + 50));
			put('docs/feature.md', 'This feature needs svelte-adapter-uws >= ' + newer + '.\n');
			expect(() => checkCompatibility(directory)).toThrow(/README\.md compatibility content is stale/);
			const { ahead } = checkCompatibility(directory, { write: true });
			expect(ahead.at(-1)).toEqual({ version: newer, files: ['docs/feature.md'] });
			expect(get('README.md')).toContain('`' + newer + '` ([docs/feature.md](./docs/feature.md))');
			expect(() => checkCompatibility(directory)).not.toThrow();
			expect(() => checkCompatibility(directory, { release: true })).toThrow(new RegExp('Documented features need svelte-adapter-uws [^\\n]*' + newer.replaceAll('.', '\\.') + ', beyond the manifest tuple ' + current.adapter_version.replaceAll('.', '\\.')));
		});
	});
});
