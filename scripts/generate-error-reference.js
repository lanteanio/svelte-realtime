// @ts-check
import { isScriptEntry } from './script-entry.js';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REALTIME_ERROR_REGISTRY } from '../src/error-registry.js';
import { CODE_GUIDANCE, EVENT_GUIDANCE } from './error-guidance.js';
import { isInformational, scanRuntimeErrors } from './runtime-error-inventory.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT = resolve(ROOT, 'docs/errors.md');
const GUIDANCE_FIELDS = Object.freeze(['cause', 'consequence', 'automaticRecovery', 'nextAction']);
const PRINTABLE_ASCII = /^[\x20-\x7e]+$/;

/**
 * @param {ReadonlyArray<import('../src/error-registry.js').RealtimeErrorDefinition>} registry
 */
export function validateErrorRegistry(registry = REALTIME_ERROR_REGISTRY) {
	/** @type {string[]} */
	const errors = [];
	const ids = new Set();
	const anchors = new Set();
	const prefixes = new Set();
	for (const [index, entry] of registry.entries()) {
		const label = 'entry ' + index;
		if (!/^REALTIME-ERR-[A-Z0-9-]+$/.test(entry.id)) errors.push(label + ' has an invalid id');
		if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(entry.anchor)) errors.push(label + ' has an invalid anchor');
		if (!entry.event) errors.push(label + ' is missing event');
		if (!entry.messagePrefix) errors.push(label + ' is missing messagePrefix');
		if (!entry.cause) errors.push(label + ' is missing cause');
		if (!entry.consequence) errors.push(label + ' is missing consequence');
		if (!entry.automaticRecovery) errors.push(label + ' is missing automaticRecovery');
		if (!entry.nextAction) errors.push(label + ' is missing nextAction');
		if (!entry.help) errors.push(label + ' is missing help');
		if (entry.help !== 'docs/errors.md#' + entry.anchor) errors.push(label + ' has a help route that does not match its anchor');
		if (!Array.isArray(entry.sources) || entry.sources.length === 0) errors.push(label + ' is missing sources');
		if (entry.code !== null && !/^[A-Z][A-Z0-9_]*$/.test(entry.code)) errors.push(label + ' has an invalid code');
		if (ids.has(entry.id)) errors.push('duplicate id: ' + entry.id);
		if (anchors.has(entry.anchor)) errors.push('duplicate anchor: ' + entry.anchor);
		if (prefixes.has(entry.messagePrefix)) errors.push('duplicate messagePrefix: ' + entry.messagePrefix);
		ids.add(entry.id);
		anchors.add(entry.anchor);
		prefixes.add(entry.messagePrefix);
		for (const source of entry.sources || []) {
			const sourcePath = resolve(ROOT, source);
			if (isAbsolute(source) || relative(ROOT, sourcePath).startsWith('..') || !existsSync(sourcePath)) {
				errors.push(label + ' has a missing or out-of-root source: ' + source);
			}
		}
	}
	return errors;
}

/**
 * Every emitted runtime code and every emitted failure event needs guidance,
 * and guidance for something the runtime no longer emits is refused.
 * Informational events (debug, info, trace at every emission) may go without.
 *
 * @param {ReturnType<typeof scanRuntimeErrors>} inventory
 * @param {Readonly<Record<string, Readonly<Record<string, string>>>>} codes
 * @param {Readonly<Record<string, Readonly<Record<string, string>>>>} events
 */
export function validateGuidance(inventory, codes = CODE_GUIDANCE, events = EVENT_GUIDANCE) {
	/** @type {string[]} */
	const errors = [];
	const emittedCodes = new Map(inventory.errors.map((row) => [row.key, row]));
	const emittedEvents = new Map(inventory.diagnostics.filter((row) => row.kind === 'structured event').map((row) => [row.key, row]));
	for (const row of emittedCodes.values()) {
		if (!Object.hasOwn(codes, row.key)) {
			errors.push('runtime code ' + row.key + ' (emitted in ' + row.sources.join(', ') + ') has no CODE_GUIDANCE entry in scripts/error-guidance.js');
		}
	}
	for (const row of emittedEvents.values()) {
		if (!isInformational(row) && !Object.hasOwn(events, row.key)) {
			errors.push('event ' + row.key + ' (severity ' + row.severities.join('/') + ', emitted in ' + row.sources.join(', ') + ') has no EVENT_GUIDANCE entry in scripts/error-guidance.js');
		}
	}
	for (const key of Object.keys(codes)) {
		if (!emittedCodes.has(key)) errors.push('CODE_GUIDANCE.' + key + ' documents a code that nothing in src emits');
	}
	for (const key of Object.keys(events)) {
		if (!emittedEvents.has(key)) errors.push('EVENT_GUIDANCE[' + JSON.stringify(key) + '] documents an event that nothing in src emits');
	}
	for (const [table, entries] of [['CODE_GUIDANCE', codes], ['EVENT_GUIDANCE', events]]) {
		for (const [key, entry] of Object.entries(entries)) {
			const label = table + '[' + JSON.stringify(key) + ']';
			for (const field of Object.keys(entry)) {
				if (!GUIDANCE_FIELDS.includes(field)) errors.push(label + ' has an unknown field: ' + field);
			}
			for (const field of GUIDANCE_FIELDS) {
				const text = entry[field];
				if (typeof text !== 'string' || !text.trim()) errors.push(label + ' is missing ' + field);
				else if (!PRINTABLE_ASCII.test(text)) errors.push(label + '.' + field + ' must be printable ASCII');
				else if (text !== text.trim()) errors.push(label + '.' + field + ' has surrounding whitespace');
			}
		}
	}
	return errors;
}

function code(value) {
	return '`' + value.replaceAll('`', '\\`') + '`';
}
function literal(value) {
	return '<code>' + value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
		.replaceAll('|', '&#124;').replaceAll('\r', '\\r').replaceAll('\n', '\\n') + '</code>';
}
function sourceLinks(paths) {
	return paths.map((path) => '[' + path + '](../' + path + ')').join(', ');
}
function patternList(row, fallback) {
	return row.prefixes.length ? row.prefixes.map(literal).join('; ') : fallback;
}
function guidanceLines(entry) {
	return [
		'- Cause: ' + entry.cause,
		'- Consequence: ' + entry.consequence,
		'- Automatic recovery: ' + entry.automaticRecovery,
		'- Next action: ' + entry.nextAction
	];
}
function sections(blocks) {
	return blocks.flatMap((block, index) => index === 0 ? block : ['', ...block]);
}

/**
 * @param {ReadonlyArray<import('../src/error-registry.js').RealtimeErrorDefinition>} registry
 * @param {ReturnType<typeof scanRuntimeErrors>} inventory
 */
export function renderErrorReference(registry = REALTIME_ERROR_REGISTRY, inventory = scanRuntimeErrors(), codes = CODE_GUIDANCE, events = EVENT_GUIDANCE) {
	const errors = [...validateErrorRegistry(registry), ...validateGuidance(inventory, codes, events)];
	if (errors.length) throw new Error('Invalid runtime error reference input:\n- ' + errors.join('\n- '));

	const structured = inventory.diagnostics.filter((row) => row.kind === 'structured event');
	const failures = structured.filter((row) => !isInformational(row));
	const informational = structured.filter((row) => isInformational(row));
	const consoleLines = inventory.diagnostics.filter((row) => row.kind === 'console line');
	const dynamicCount = inventory.dynamicSites.reduce((sum, site) => sum + site.count, 0);

	const registryRows = registry.map((entry) =>
		'| [' + code(entry.id) + '](#' + entry.anchor + ') | ' + (entry.code === null ? '-' : code(entry.code)) +
		' | ' + code(entry.event) + ' | ' + code(entry.messagePrefix) + ' |'
	);
	const registrySections = registry.map((entry) => [
		'<a id="' + entry.anchor + '"></a>',
		'### ' + code(entry.id),
		'',
		'- Runtime code: ' + (entry.code === null ? 'none (build diagnostic)' : '[' + code(entry.code) + '](#live-error-' + entry.code.toLowerCase().replaceAll('_', '-') + ')'),
		'- Event: ' + code(entry.event),
		'- Message prefix: ' + code(entry.messagePrefix),
		...guidanceLines(entry),
		'- Runtime help: ' + code(entry.help),
		'- Runtime sources: ' + entry.sources.map((source) => '[' + code(source) + '](../' + source + ')').join(', ')
	]);
	const codeSections = inventory.errors.map((row) => {
		const ids = registry.filter((entry) => entry.code === row.key);
		return [
			'<a id="' + row.anchor + '"></a>',
			'### ' + code(row.key),
			'',
			...guidanceLines(codes[row.key]),
			...(ids.length ? ['- Stable IDs: ' + ids.map((entry) => '[' + code(entry.id) + '](#' + entry.anchor + ')').join(', ')] : []),
			'- Message patterns: ' + patternList(row, 'computed at every site (see [dynamic emission sites](#dynamic-emission-sites)).'),
			'- Owning sources: ' + sourceLinks(row.sources)
		];
	});
	const eventSections = failures.map((row) => [
		'<a id="' + row.anchor + '"></a>',
		'### ' + code(row.key),
		'',
		'- Severity: ' + row.severities.join(', '),
		...(row.delivery.length ? ['- Delivered to: ' + row.delivery.join('; ')] : []),
		'- Message patterns: ' + patternList(row, 'computed (search the event name).'),
		...guidanceLines(events[row.key]),
		'- Owning sources: ' + sourceLinks(row.sources)
	]);
	const informationalRows = informational.map((row) =>
		'| <a id="' + row.anchor + '"></a>' + code(row.key) + ' | ' + row.severities.join(', ') + ' | ' +
		patternList(row, 'computed') + ' | ' + sourceLinks(row.sources) + ' |'
	);
	const consoleSections = consoleLines.map((row) => [
		'<a id="' + row.anchor + '"></a>',
		'### ' + literal(row.key),
		'',
		'- Message patterns: ' + patternList(row, 'computed'),
		'- Owning sources: ' + sourceLinks(row.sources)
	]);
	const dynamicRows = inventory.dynamicSites.map((site) =>
		'| [' + site.path + '](../' + site.path + ') | ' + code(site.scope) + ' | ' + site.kind + ' | ' + site.count + ' |'
	);

	return [
		'# Runtime error reference',
		'',
		'Search this page with the exact error code, event name, stable ID, or the beginning of the message you saw.',
		'',
		'This file is generated by `npm run generate:errors` from the runtime error registry (`src/error-registry.js`), the operator guidance in `scripts/error-guidance.js`, and a parse of every emission in `src/**/*.js`. Do not edit it by hand. Coverage at generation time:',
		'',
		'- ' + registry.length + ' [stable IDs](#stable-ids) with full guidance. Their runtime messages append the ID and the help route to this page.',
		'- ' + inventory.errors.length + ' [runtime error codes](#runtime-error-codes) (`LiveError` on the server, `RpcError` on the client, error replies on the wire), every one with cause, consequence, automatic recovery and next action.',
		'- ' + failures.length + ' [failure events](#operational-events) (warn, error or fatal), every one with full guidance, and ' + informational.length + ' [informational events](#informational-events) listed without guidance because they report normal operation.',
		'- ' + consoleLines.length + ' [console lines](#console-lines) listed by searchable text and owning source only. These carry no cause or recovery guidance.',
		'- ' + dynamicCount + ' emission sites with a computed code, event or message, listed under [dynamic emission sites](#dynamic-emission-sites).',
		'',
		'A new error code, or a new event emitted at warn, error or fatal, fails generation until it has guidance; so does guidance for a code or event the runtime no longer emits. An event emitted with a severity the parser cannot resolve counts as a failure event.',
		'',
		'Message patterns show the literal text the runtime prints. `<name>` stands for a computed value, named after the variable or property it comes from; search for the literal text around it. Escaped `\\n` and `\\r` stand for actual newlines and carriage returns. Code and event anchors stay stable when message text changes.',
		'',
		'<a id="stable-ids"></a>',
		'## Stable IDs',
		'',
		'| Stable ID | Runtime code | Event | Message prefix |',
		'|---|---|---|---|',
		...registryRows,
		'',
		...sections(registrySections),
		'',
		'<a id="runtime-error-codes"></a>',
		'## Runtime error codes',
		'',
		'A code reaches the client as `RpcError.code` and is thrown on the server as `LiveError.code`. Application handlers may throw any of these codes themselves, and a client forwards the code a server sent.',
		'',
		'| Code | Message patterns |',
		'|---|---|',
		...inventory.errors.map((row) => '| [' + code(row.key) + '](#' + row.anchor + ') | ' + patternList(row, 'computed') + ' |'),
		'',
		...sections(codeSections),
		'',
		'<a id="operational-events"></a>',
		'## Operational events',
		'',
		'Structured events emitted through `emitOperationalEvent()` go to the sink installed with `setOperationalEventSink()` and, without a sink, to the console. Events marked console only are printed directly and never reach the sink. Every console copy is one line in this format, so the event name is searchable in plain logs:',
		'',
		'`[lantean/diagnostic source=svelte-realtime component=<component> event=<event> severity=<severity>] <message>`',
		'',
		...sections(eventSections),
		'',
		'<a id="informational-events"></a>',
		'### Informational events',
		'',
		'| Event | Severity | Message patterns | Owning sources |',
		'|---|---|---|---|',
		...informationalRows,
		'',
		'<a id="console-lines"></a>',
		'## Console lines',
		'',
		'Listing only: plain `console.warn` and `console.error` lines, outside the structured event format, indexed by searchable text so a pasted log line lands here. Each anchor is derived from the literal text and changes when that text changes. Lines whose first argument is a structured diagnostic are indexed above by their event.',
		'',
		...sections(consoleSections),
		'',
		'<a id="dynamic-emission-sites"></a>',
		'## Dynamic emission sites',
		'',
		'These emitters compute their code, event or message, so the parser cannot resolve them to literal text. Wire forwarding and application-provided messages vary at runtime. Sites are keyed by file, enclosing function and emitter, so an edit elsewhere in the file leaves this table unchanged.',
		'',
		'| Source | Function | Emitter | Sites |',
		'|---|---|---|---|',
		...dynamicRows,
		''
	].join('\n');
}

export function checkErrorReference() {
	const expected = renderErrorReference();
	const actual = existsSync(OUTPUT) ? readFileSync(OUTPUT, 'utf8') : '';
	if (actual !== expected) {
		throw new Error('docs/errors.md is stale. Regenerate it with: npm run generate:errors');
	}
}

if (isScriptEntry(import.meta.url)) {
	const mode = process.argv[2];
	if (mode === '--write') {
		mkdirSync(dirname(OUTPUT), { recursive: true });
		writeFileSync(OUTPUT, renderErrorReference(), 'utf8');
	} else if (mode === '--check') {
		checkErrorReference();
	} else {
		throw new Error('Usage: node scripts/generate-error-reference.js --check|--write');
	}
}
