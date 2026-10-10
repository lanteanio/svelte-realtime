// Browser-safe formatting half of the shared diagnostic contract. Keep this
// module free of Node imports: the public client exports `shared/assert.js`,
// which uses the formatter when a client invariant fails.

export const DIAGNOSTIC_PREFIX = 'lantean/diagnostic';

const UNSAFE_TEXT = /[\u0000-\u001f\u007f-\uffff]/g;

function unicodeEscape(character) {
	return '\\u' + character.charCodeAt(0).toString(16).padStart(4, '0');
}

function bounded(value, fallback = 'unknown') {
	const text = String(value ?? fallback)
		.replace(UNSAFE_TEXT, unicodeEscape)
		.replace(/\s+/g, ' ')
		.trim();
	return (text || fallback).slice(0, 512);
}

function asciiJson(value) {
	return JSON.stringify(value).replace(/[\u007f-\uffff]/g, unicodeEscape);
}

export function diagnosticErrorMessage(error) {
	let message;
	try {
		message = error?.message;
	} catch {
		// A thrown Proxy or accessor must not break the original error path.
	}
	try {
		return String(message ?? error);
	} catch {
		return 'Unknown error';
	}
}

export function createDiagnostic(input) {
	return {
		schemaVersion: 1,
		occurredAt: input.occurredAt ?? null,
		source: input.source,
		component: input.component,
		event: input.event,
		severity: input.severity,
		level: input.severity,
		dataClass: input.dataClass ?? 'operational',
		message: bounded(input.message),
		attributes: input.attributes ?? null
	};
}

export function formatDiagnostic(input) {
	const record = createDiagnostic(input);
	const suffix = asciiJson(record);
	return `[${DIAGNOSTIC_PREFIX} source=${record.source} component=${record.component} event=${record.event} severity=${record.severity}] ${record.message} ${suffix}`;
}
