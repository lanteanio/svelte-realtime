// @ts-check
import { isScriptEntry } from './script-entry.js';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'acorn';
import { REALTIME_ERROR_IDS, REALTIME_ERROR_REGISTRY } from '../src/error-registry.js';
import { CODE_GUIDANCE, EVENT_GUIDANCE } from './error-guidance.js';
import { CONSOLE_EXCLUDED_MODULES, CONSOLE_REASONS, DYNAMIC_SITE_REASONS } from './error-decisions.js';
import { consoleSiteKey, dynamicSiteKey, isInformational, scanRuntimeErrors } from './runtime-error-inventory.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT = resolve(ROOT, 'docs/errors.md');
const GUIDANCE_FIELDS = Object.freeze(['cause', 'consequence', 'automaticRecovery', 'nextAction']);
const PRINTABLE_ASCII = /^[\x20-\x7e]+$/;
const PACKAGE_VERSION = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')).version;
export const DECISIONS = Object.freeze({ dynamic: DYNAMIC_SITE_REASONS, excluded: CONSOLE_EXCLUDED_MODULES, console: CONSOLE_REASONS });

// Where each sibling package keeps its own error reference. When a sibling
// checkout sits next to this repository, --check verifies the linked document
// exists there, so a moved document fails here instead of shipping a dead link.
const SIBLING_ERROR_DOCUMENTS = Object.freeze([
	Object.freeze({ repo: 'svelte-adapter-uws', label: 'svelte-adapter-uws errors', documentPath: 'docs/errors.md' }),
	Object.freeze({ repo: 'svelte-adapter-uws-extensions', label: 'svelte-adapter-uws-extensions errors', documentPath: 'docs/errors.md' })
]);

export function releaseDocumentationRef(version = PACKAGE_VERSION) {
	return String(version).includes('-') ? 'dev' : 'main';
}

export function checkSiblingDocuments(parentDirectory = dirname(ROOT)) {
	/** @type {string[]} */
	const errors = [];
	for (const sibling of SIBLING_ERROR_DOCUMENTS) {
		const checkout = resolve(parentDirectory, sibling.repo);
		if (!existsSync(checkout)) continue;
		if (!existsSync(resolve(checkout, sibling.documentPath))) {
			errors.push(sibling.repo + ': the local checkout at ' + checkout + ' has no ' + sibling.documentPath +
				'; update SIBLING_ERROR_DOCUMENTS in scripts/generate-error-reference.js, then rerun --write');
		}
	}
	return errors;
}

/**
 * Every computed emission site and every console warning or error outside
 * the excluded modules needs a recorded decision, and a decision that matches
 * nothing is refused.
 *
 * @param {ReturnType<typeof scanRuntimeErrors>} inventory
 * A computed-site decision records how many sites it covers, so a new
 * computed site in an already decided function needs a fresh decision while a
 * line move does not. A registry-printed console line must sit in one of its
 * entry's declared sources.
 *
 * @param {{ dynamic: Readonly<Record<string, { count: number, reason: string }>>, excluded: Readonly<Record<string, string>>, console: Readonly<Record<string, string>> }} decisions
 * @param {ReadonlyArray<import('../src/error-registry.js').RealtimeErrorDefinition>} registry
 */
export function validateDecisions(inventory, decisions = DECISIONS, registry = REALTIME_ERROR_REGISTRY) {
	/** @type {string[]} */
	const errors = [];
	const sites = new Map(inventory.dynamicSites.map((site) => [dynamicSiteKey(site), site]));
	for (const [key, site] of sites) {
		const decision = decisions.dynamic[key];
		if (!Object.hasOwn(decisions.dynamic, key)) errors.push('dynamic emission site ' + JSON.stringify(key) + ' (' + site.count + ' site' + (site.count === 1 ? '' : 's') + ') has no DYNAMIC_SITE_REASONS entry in scripts/error-decisions.js');
		else if (decision.count !== site.count) errors.push('DYNAMIC_SITE_REASONS[' + JSON.stringify(key) + '] records ' + decision.count + ' site(s) but the function now has ' + site.count + '; decide the changed sites and update the count');
	}
	for (const key of Object.keys(decisions.dynamic)) {
		if (!sites.has(key)) errors.push('DYNAMIC_SITE_REASONS[' + JSON.stringify(key) + '] matches no computed emission site');
	}
	const consoleKeys = new Set(), consolePaths = new Set();
	for (const site of inventory.consoleSites) {
		consolePaths.add(site.path);
		if (site.registered) {
			const entry = registry.find((item) => item.id === site.registryId);
			if (!entry || !entry.sources.includes(site.path)) errors.push('console line in ' + site.path + ' prints through ' + (site.registryId ?? 'an unknown registry entry') + ', whose sources do not list that file');
			continue;
		}
		if (Object.hasOwn(decisions.excluded, site.path)) continue;
		const key = consoleSiteKey(site);
		consoleKeys.add(key);
		if (!Object.hasOwn(decisions.console, key)) errors.push('console line ' + JSON.stringify(key) + ' is neither printed through the error registry nor given a CONSOLE_REASONS entry in scripts/error-decisions.js');
	}
	for (const key of Object.keys(decisions.console)) {
		if (!consoleKeys.has(key)) errors.push('CONSOLE_REASONS[' + JSON.stringify(key) + '] matches no console line');
	}
	for (const path of Object.keys(decisions.excluded)) {
		if (!consolePaths.has(path)) errors.push('CONSOLE_EXCLUDED_MODULES[' + JSON.stringify(path) + '] prints no console warning or error');
	}
	for (const [key, decision] of Object.entries(decisions.dynamic)) {
		if (!Number.isInteger(decision?.count) || decision.count < 1) errors.push('DYNAMIC_SITE_REASONS[' + JSON.stringify(key) + '] needs a positive integer count');
	}
	const dynamicReasons = Object.fromEntries(Object.entries(decisions.dynamic).map(([key, decision]) => [key, decision?.reason]));
	for (const [table, entries] of [['DYNAMIC_SITE_REASONS', dynamicReasons], ['CONSOLE_EXCLUDED_MODULES', decisions.excluded], ['CONSOLE_REASONS', decisions.console]]) {
		for (const [key, reason] of Object.entries(entries)) {
			if (typeof reason !== 'string' || !reason.trim()) errors.push(table + '[' + JSON.stringify(key) + '] has no reason');
			else if (!PRINTABLE_ASCII.test(reason)) errors.push(table + '[' + JSON.stringify(key) + '] must be printable ASCII');
		}
	}
	return errors;
}

/** @type {Map<string, Set<string>>} */
const referencedKeys = new Map();
/**
 * `REALTIME_ERROR_IDS.<KEY>` member expressions in a source file, read from the
 * syntax tree so a key named only in a comment or a string does not count.
 * @param {string} path
 */
function registryKeysReferenced(path) {
	let keys = referencedKeys.get(path);
	if (keys) return keys;
	keys = new Set();
	/** @param {any} node */
	const visit = (node) => {
		if (!node || typeof node.type !== 'string') return;
		if (node.type === 'MemberExpression' && !node.computed && node.object.type === 'Identifier' && node.object.name === 'REALTIME_ERROR_IDS') keys.add(node.property.name);
		for (const child of Object.values(node)) {
			if (Array.isArray(child)) child.forEach(visit);
			else if (child && typeof child === 'object') visit(child);
		}
	};
	visit(parse(readFileSync(path, 'utf8'), { sourceType: 'module', ecmaVersion: 'latest' }));
	referencedKeys.set(path, keys);
	return keys;
}

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
		// A registered entry nothing emits documents text no log can contain.
		const key = Object.keys(REALTIME_ERROR_IDS).find((name) => REALTIME_ERROR_IDS[name] === entry.id);
		const emitted = key !== undefined && (entry.sources || []).some((source) => {
			const sourcePath = resolve(ROOT, source);
			return existsSync(sourcePath) && registryKeysReferenced(sourcePath).has(key);
		});
		if (!emitted) errors.push(label + ' (' + entry.id + ') is not emitted through REALTIME_ERROR_IDS in any of its sources');
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
export function renderErrorReference(registry = REALTIME_ERROR_REGISTRY, inventory = scanRuntimeErrors(), codes = CODE_GUIDANCE, events = EVENT_GUIDANCE, decisions = DECISIONS) {
	const errors = [...validateErrorRegistry(registry), ...validateGuidance(inventory, codes, events), ...validateDecisions(inventory, decisions, registry)];
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
		'- Runtime code: ' + (entry.code === null ? 'none' : '[' + code(entry.code) + '](#live-error-' + entry.code.toLowerCase().replaceAll('_', '-') + ')'),
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
	const registryByPrefix = new Map(registry.map((entry) => [entry.messagePrefix, entry]));
	const decisionLines = (row) => inventory.consoleSites.filter((site) => site.id === row.key).map((site) => {
		const owner = '[' + site.path + '](../' + site.path + ')';
		if (site.registered) {
			const entry = registryByPrefix.get(site.text);
			return '- ' + owner + ': printed through ' + (entry ? '[' + code(entry.id) + '](#' + entry.anchor + ')' : 'the error registry');
		}
		if (Object.hasOwn(decisions.excluded, site.path)) return '- ' + owner + ': outside the decision (' + decisions.excluded[site.path] + ')';
		return '- ' + owner + ': ' + decisions.console[consoleSiteKey(site)];
	});
	const consoleSections = consoleLines.map((row) => [
		'<a id="' + row.anchor + '"></a>',
		'### ' + literal(row.key),
		'',
		'- Message pattern: ' + patternList(row, 'computed'),
		...decisionLines(row)
	]);
	const dynamicRows = inventory.dynamicSites.map((site) =>
		'| [' + site.path + '](../' + site.path + ') | ' + code(site.scope) + ' | ' + site.kind + ' | ' + site.count + ' | ' + decisions.dynamic[dynamicSiteKey(site)].reason + ' |'
	);
	const siblingRef = releaseDocumentationRef();

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
		'- ' + consoleLines.length + ' [console lines](#console-lines) indexed by searchable text. A server, Vite or shared console warning or error is either printed through the registry with a stable ID or carries a recorded reason why it needs no guided entry; browser and scaffolder output is listed without one.',
		'- ' + dynamicCount + ' emission sites with a computed code, event or message, each with a recorded reason, under [dynamic emission sites](#dynamic-emission-sites).',
		'',
		'Generation fails on a new error code or a new event emitted at warn, error or fatal without guidance, on a new console warning or error without a stable ID or a recorded reason, and on a new computed emission site without a recorded reason. It also fails on guidance or a reason that no longer matches anything the runtime emits. An event emitted with a severity the parser cannot resolve counts as a failure event. Codes and messages are followed through local constants and through helper functions to their call sites before a site counts as computed.',
		'',
		'This is the svelte-realtime part of the ecosystem index. The sibling packages generate and ship their own references:',
		'',
		...SIBLING_ERROR_DOCUMENTS.map((sibling) => '- [' + sibling.label + '](https://github.com/lanteanio/' + sibling.repo + '/blob/' + siblingRef + '/' + sibling.documentPath + ')'),
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
		'Plain `console.warn` and `console.error` lines, outside the structured event format, indexed by searchable text so a pasted log line lands here. Each line shows its decision: printed through a stable ID, a recorded reason why an operator needs nothing more than the line itself, or a module outside the decision. Each anchor is derived from the text and changes when the text changes. Lines whose first argument is a structured diagnostic are indexed above by their event.',
		'',
		...sections(consoleSections),
		'',
		'<a id="dynamic-emission-sites"></a>',
		'## Dynamic emission sites',
		'',
		'These emitters compute their code, event or message, so the parser cannot resolve them to literal text. Each carries the recorded reason where the value comes from. Sites are keyed by file, enclosing function and emitter, so an edit elsewhere in the file leaves this table unchanged.',
		'',
		'| Source | Function | Emitter | Sites | Reason |',
		'|---|---|---|---|---|',
		...dynamicRows,
		''
	].join('\n');
}

export function checkErrorReference() {
	const siblingErrors = checkSiblingDocuments();
	if (siblingErrors.length) throw new Error(siblingErrors.join('\n'));
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
