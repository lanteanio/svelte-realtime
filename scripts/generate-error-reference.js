// @ts-check
import { isScriptEntry } from './script-entry.js';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REALTIME_ERROR_REGISTRY } from '../src/error-registry.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT = resolve(ROOT, 'docs/errors.md');

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

function code(value) {
	return '`' + value.replaceAll('`', '\\`') + '`';
}

export function renderErrorReference(registry = REALTIME_ERROR_REGISTRY) {
	const errors = validateErrorRegistry(registry);
	if (errors.length) throw new Error('Invalid runtime error registry:\n- ' + errors.join('\n- '));

	const rows = registry.map((entry) =>
		'| ' + code(entry.id) + ' | ' + (entry.code === null ? '-' : code(entry.code)) +
		' | ' + code(entry.event) + ' | ' + code(entry.messagePrefix) + ' |'
	);
	const sections = registry.map((entry) => [
		'<a id="' + entry.anchor + '"></a>',
		'## ' + code(entry.id),
		'',
		'- Runtime code: ' + (entry.code === null ? 'none (build diagnostic)' : code(entry.code)),
		'- Event: ' + code(entry.event),
		'- Message prefix: ' + code(entry.messagePrefix),
		'- Cause: ' + entry.cause,
		'- Consequence: ' + entry.consequence,
		'- Automatic recovery: ' + entry.automaticRecovery,
		'- Next action: ' + entry.nextAction,
		'- Runtime help: ' + code(entry.help),
		'- Runtime sources: ' + entry.sources.map((source) => '[' + code(source) + '](../' + source + ')').join(', ')
	].join('\n'));

	return [
		'# Runtime error reference',
		'',
		'This file is generated from the runtime-owned registry. Do not edit it by hand.',
		'Runtime messages preserve the documented prefix and append the stable ID plus this package-local help route.',
		'',
		'| Stable ID | Runtime code | Event | Message prefix |',
		'|---|---|---|---|',
		...rows,
		'',
		...sections.flatMap((section, index) => index === 0 ? [section] : ['', section]),
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
