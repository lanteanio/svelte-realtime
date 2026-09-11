// @ts-check

/**
 * @typedef {object} RealtimeErrorDefinition
 * @property {string} id Stable, searchable documentation identifier.
 * @property {string | null} code Runtime error code, or null for build diagnostics.
 * @property {string} event Stable name for the runtime event.
 * @property {string} messagePrefix Exact prefix emitted by the runtime.
 * @property {string} cause
 * @property {string} consequence
 * @property {string} automaticRecovery
 * @property {string} nextAction
 * @property {ReadonlyArray<string>} sources Repository-relative owning source files.
 * @property {string} anchor Documentation anchor.
 * @property {string} help Package-local help route.
 */

export const REALTIME_ERROR_IDS = Object.freeze({
	INVALID_USER_ID: 'REALTIME-ERR-INVALID-USER-ID',
	LIVE_RESOLVE: 'REALTIME-ERR-LIVE-RESOLVE',
	UPLOAD_START_LIMIT: 'REALTIME-ERR-UPLOAD-START-LIMIT',
	UPLOAD_MAX_SIZE: 'REALTIME-ERR-UPLOAD-MAX-SIZE'
});

/** @type {ReadonlyArray<Readonly<RealtimeErrorDefinition>>} */
export const REALTIME_ERROR_REGISTRY = Object.freeze([
	Object.freeze({
		id: REALTIME_ERROR_IDS.INVALID_USER_ID,
		code: 'INVALID_USER_ID',
		event: 'ctx.signal.invalid-user-id',
		messagePrefix: 'ctx.signal:',
		cause: 'ctx.signal(userId, ...) received a value that is not a non-empty string of at most 256 characters, or it contains a control character, double quote, or backslash.',
		consequence: 'The signal is not published and the caller receives an INVALID_USER_ID LiveError.',
		automaticRecovery: 'None; malformed identity input is not retried.',
		nextAction: 'Pass the canonical validated user ID used by enableSignals(). Do not retry the same malformed value.',
		sources: Object.freeze(['src/server/ctx.js']),
		anchor: 'realtime-err-invalid-user-id',
		help: 'docs/errors.md#realtime-err-invalid-user-id'
	}),
	Object.freeze({
		id: REALTIME_ERROR_IDS.LIVE_RESOLVE,
		code: null,
		event: 'vite.live.resolve-failed',
		messagePrefix: '[svelte-realtime] Could not resolve $live/',
		cause: 'A $live/<module> virtual import has no matching JavaScript or TypeScript file under the configured live directory.',
		consequence: 'The requested virtual module cannot load, so development or the build stops at that import.',
		automaticRecovery: 'Vite resolves the import again after the module graph changes or the command is rerun.',
		nextAction: 'Correct the import path, add the matching live module, or configure the live directory.',
		sources: Object.freeze(['src/vite/plugin.js']),
		anchor: 'realtime-err-live-resolve',
		help: 'docs/errors.md#realtime-err-live-resolve'
	}),
	Object.freeze({
		id: REALTIME_ERROR_IDS.UPLOAD_START_LIMIT,
		code: 'PAYLOAD_TOO_LARGE',
		event: 'upload.pending-size.exceeded',
		messagePrefix: 'upload exceeds limit during start',
		cause: 'Upload bytes crossed the protected pending-phase cap before the endpoint handler and its options finished resolving.',
		consequence: 'The upload is aborted before its endpoint handler begins and returns PAYLOAD_TOO_LARGE.',
		automaticRecovery: 'None; the aborted stream cannot be resumed.',
		nextAction: 'Reduce the initial or pending upload volume and retry with a new stream.',
		sources: Object.freeze(['src/server/upload.js']),
		anchor: 'realtime-err-upload-start-limit',
		help: 'docs/errors.md#realtime-err-upload-start-limit'
	}),
	Object.freeze({
		id: REALTIME_ERROR_IDS.UPLOAD_MAX_SIZE,
		code: 'PAYLOAD_TOO_LARGE',
		event: 'upload.max-size.exceeded',
		messagePrefix: 'upload exceeds maxSize',
		cause: 'The received upload bytes exceeded the maxSize configured by the resolved upload handler.',
		consequence: 'The upload is aborted and returns PAYLOAD_TOO_LARGE without invoking or completing the handler.',
		automaticRecovery: 'None; the aborted stream cannot be resumed.',
		nextAction: 'Reduce the upload or deliberately raise the audited maxSize, then start a new upload.',
		sources: Object.freeze(['src/server/upload.js']),
		anchor: 'realtime-err-upload-max-size',
		help: 'docs/errors.md#realtime-err-upload-max-size'
	})
]);

const errorById = new Map(REALTIME_ERROR_REGISTRY.map((entry) => [entry.id, entry]));

/**
 * Resolve one owned runtime error definition.
 * @param {string} id
 * @returns {Readonly<RealtimeErrorDefinition>}
 */
export function realtimeErrorDefinition(id) {
	const definition = errorById.get(id);
	if (!definition) throw new TypeError('Unknown svelte-realtime error id: ' + id);
	return definition;
}

/**
 * Resolve the runtime code for an error that has one.
 * @param {string} id
 */
export function realtimeErrorCode(id) {
	const definition = realtimeErrorDefinition(id);
	if (definition.code === null) {
		throw new TypeError('svelte-realtime error id has no runtime code: ' + id);
	}
	return definition.code;
}

/**
 * Build an emitted message from its registry-owned exact prefix.
 * The caller owns any separator at the start of `detail`.
 * @param {string} id
 * @param {string} [detail]
 */
export function realtimeErrorMessage(id, detail = '') {
	const definition = realtimeErrorDefinition(id);
	return definition.messagePrefix + detail + ' [' + definition.id + '] See: ' + definition.help;
}
