// Wire-compatible bridge for the public diagnostic contract exported by
// svelte-adapter-uws/observability. The current peer floor predates that
// subpath, so realtime cannot import it until the next coordinated floor
// raise. Prefix contract tests keep this small bridge byte-compatible.

import { wallIso } from './runtime.js';
import { createDiagnostic, formatDiagnostic } from './diagnostic-format.js';

export {
	DIAGNOSTIC_PREFIX,
	diagnosticErrorMessage,
	createDiagnostic,
	formatDiagnostic
} from './diagnostic-format.js';

const OPERATIONAL_EVENT_SINK = Symbol.for('oss-realtime.operational-event-sink.v1');
const OPERATIONAL_EVENT_SINK_REGISTRY = Symbol.for('oss-realtime.operational-event-sink-registry.v1');

function defaultOperationalEventSink(record) {
	const method = record.severity === 'debug' ? 'debug'
		: record.severity === 'info' ? 'info'
			: record.severity === 'warn' ? 'warn' : 'error';
	console[method](formatDiagnostic(record));
}

function sinkFailureFallback(record) {
	defaultOperationalEventSink(record);
	defaultOperationalEventSink(createDiagnostic({
		source: 'svelte-realtime',
		component: 'runtime.observability',
		event: 'operational.sink.failed',
		severity: 'error',
		message: 'The configured operational event sink failed; console fallback was restored for this event.',
		occurredAt: wallIso(),
		attributes: { originalSource: record.source, originalEvent: record.event }
	}));
}

function operationalEventSinkRegistry() {
	let registry = globalThis[OPERATIONAL_EVENT_SINK_REGISTRY];
	if (!registry || !Array.isArray(registry.entries)) {
		const inherited = globalThis[OPERATIONAL_EVENT_SINK];
		registry = {
			entries: typeof inherited === 'function'
				? [{ sink: inherited, active: true }]
				: []
		};
		globalThis[OPERATIONAL_EVENT_SINK_REGISTRY] = registry;
	}
	return registry;
}

function syncOperationalEventSink(registry) {
	const current = registry.entries[registry.entries.length - 1];
	if (current) globalThis[OPERATIONAL_EVENT_SINK] = current.sink;
	else delete globalThis[OPERATIONAL_EVENT_SINK];
}

export function setOperationalEventSink(sink) {
	if (sink !== null && typeof sink !== 'function') {
		throw new TypeError('operational event sink must be a function or null');
	}
	const registry = operationalEventSinkRegistry();
	if (sink === null) {
		for (const entry of registry.entries) entry.active = false;
		registry.entries.length = 0;
		delete globalThis[OPERATIONAL_EVENT_SINK];
		return () => {};
	}
	const entry = { sink, active: true };
	registry.entries.push(entry);
	globalThis[OPERATIONAL_EVENT_SINK] = sink;
	return () => {
		if (!entry.active) return;
		entry.active = false;
		const index = registry.entries.indexOf(entry);
		if (index !== -1) registry.entries.splice(index, 1);
		syncOperationalEventSink(registry);
	};
}

export function emitOperationalEvent(input) {
	const record = createDiagnostic({
		...input,
		occurredAt: input?.occurredAt ?? wallIso()
	});
	const sink = globalThis[OPERATIONAL_EVENT_SINK];
	if (typeof sink !== 'function') {
		defaultOperationalEventSink(record);
		return record;
	}
	try {
		const result = sink(record);
		if (result && typeof result.then === 'function') {
			Promise.resolve(result).catch(() => sinkFailureFallback(record));
		}
	} catch {
		sinkFailureFallback(record);
	}
	return record;
}
