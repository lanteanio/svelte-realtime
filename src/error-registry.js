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
	UPLOAD_MAX_SIZE: 'REALTIME-ERR-UPLOAD-MAX-SIZE',
	ROOM_HISTORY_CAPTURE: 'REALTIME-ERR-ROOM-HISTORY-CAPTURE',
	DOC_PERSIST: 'REALTIME-ERR-DOC-PERSIST',
	LAZY_REGISTRATION: 'REALTIME-ERR-LAZY-REGISTRATION',
	ADAPTER_VERSION_SKEW: 'REALTIME-ERR-ADAPTER-VERSION-SKEW',
	SMOOTH_CUSTOM_SHOT_CONFIG: 'REALTIME-ERR-SMOOTH-CUSTOM-SHOT-CONFIG'
});

/** @type {ReadonlyArray<Readonly<RealtimeErrorDefinition>>} */
export const REALTIME_ERROR_REGISTRY = Object.freeze([
	Object.freeze({
		id: REALTIME_ERROR_IDS.SMOOTH_CUSTOM_SHOT_CONFIG,
		code: null,
		event: 'smooth.custom-shot.invalid-config',
		messagePrefix: '[svelte-realtime] live.smooth() hitTest.resolveShot',
		cause: 'The custom shot resolver is not a function, or its declaration also contains built-in ray geometry or onHit.',
		consequence: 'The smooth declaration throws during registration; no malformed resolver is installed.',
		automaticRecovery: 'None; changing or retrying incoming shots cannot repair a declaration.',
		nextAction: 'Provide resolveShot(ctx, command, timing) for application-owned projectiles, or use shot, hitbox/resolve and onHit for built-in ray resolution. Do not combine both modes.',
		sources: Object.freeze(['src/server/smooth.js']),
		anchor: 'realtime-err-smooth-custom-shot-config',
		help: 'docs/errors.md#realtime-err-smooth-custom-shot-config'
	}),
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
		nextAction: 'Reduce the upload or deliberately raise maxSize, then start a new upload.',
		sources: Object.freeze(['src/server/upload.js']),
		anchor: 'realtime-err-upload-max-size',
		help: 'docs/errors.md#realtime-err-upload-max-size'
	}),
	Object.freeze({
		id: REALTIME_ERROR_IDS.ROOM_HISTORY_CAPTURE,
		code: null,
		event: 'room.history.capture-failed',
		messagePrefix: '[svelte-realtime] history capture failed; suppressing further capture errors for this live.room declaration',
		cause: 'Recording the history entry after a successful `live.room` action threw: the `history.capture` function itself, freezing the snapshot it returned (for example a value that cannot be frozen), or writing it to the history store.',
		consequence: 'The action still succeeds and its result is returned, but no history entry is recorded for it, so a later `ctx.compensate` that rewinds to that moment evaluates against the previous entry. Later capture failures in any room of the same `live.room` declaration are not printed.',
		automaticRecovery: 'None for the missed entry. The next action records again, and a capture that stops throwing records normally.',
		nextAction: 'Fix the capture function using the error printed with this line; it must return a snapshot of the room state without throwing. Restart the process to see further capture errors after fixing.',
		sources: Object.freeze(['src/server/room.js']),
		anchor: 'realtime-err-room-history-capture',
		help: 'docs/errors.md#realtime-err-room-history-capture'
	}),
	Object.freeze({
		id: REALTIME_ERROR_IDS.DOC_PERSIST,
		code: null,
		event: 'doc.persist.failed',
		messagePrefix: '[svelte-realtime] document persistence failed:',
		cause: 'The `persist.load` or `persist.store` hook of a `live.doc` declaration threw or rejected, and the declaration has no `onError` handler. The line names the declaration, the operation (`load` or `store`) and the topic.',
		consequence: 'A failed store leaves the document dirty in memory: it is not durable until a store succeeds, and the replica is not unloaded meanwhile. A failed load opens nothing: the replica forgets the topic, and every waiting sync receives INTERNAL_ERROR with the generic message `Internal server error`. Backend details stay in server-side error observers.',
		automaticRecovery: 'A failed store is retried on the `debounceMaxWait` cadence, printing this line on every failed attempt. A failed load is retried by the next sync call for that topic.',
		nextAction: 'Fix the storage backend or the hook using the error printed with this line. Pass `onError` to the declaration to route these failures into your own logging or alerting.',
		sources: Object.freeze(['src/server/crdt.js']),
		anchor: 'realtime-err-doc-persist',
		help: 'docs/errors.md#realtime-err-doc-persist'
	}),
	Object.freeze({
		id: REALTIME_ERROR_IDS.LAZY_REGISTRATION,
		code: null,
		event: 'lazy.registration.failed',
		messagePrefix: '[svelte-realtime] Failed to resolve lazy registration for',
		cause: 'Loading a lazily registered live module threw while the server resolved its deferred cron, derived, effect, webhook, aggregate or room-action registrations.',
		consequence: 'That path stays unregistered or only partly registered for the life of the process: when the failure comes after some registration steps (a derived stream registered as a function but not as derived, some room actions but not the rest), those steps stay. A missing cron never runs, a missing derived stream or effect never reacts, and calls to missing room actions answer NOT_FOUND. Other lazy registrations still resolve.',
		automaticRecovery: 'None. Lazy registrations resolve once per process and the failed entry is not retried.',
		nextAction: 'Fix the module error printed with this line, then restart the server.',
		sources: Object.freeze(['src/server/lazy.js']),
		anchor: 'realtime-err-lazy-registration',
		help: 'docs/errors.md#realtime-err-lazy-registration'
	}),
	Object.freeze({
		id: REALTIME_ERROR_IDS.ADAPTER_VERSION_SKEW,
		code: null,
		event: 'vite.optimize.adapter-version-skew',
		messagePrefix: '[svelte-realtime] The linked svelte-realtime and the app resolve different svelte-adapter-uws versions',
		cause: 'svelte-realtime is linked from outside node_modules, and the svelte-adapter-uws it resolves from its own location is a different version than the one the app resolves.',
		consequence: "The dev server pre-bundles the app's adapter client and serves it to the app and to the linked svelte-realtime alike, while a build resolves the adapter svelte-realtime imports from its own location, so development and the build can run different adapter versions.",
		automaticRecovery: "None; the warning is printed once per process and version pair, and development keeps serving the app's copy.",
		nextAction: 'Install the same svelte-adapter-uws version in the app and in the linked svelte-realtime checkout, or install svelte-realtime from the registry instead of linking it.',
		sources: Object.freeze(['src/vite/optimize-deps.js']),
		anchor: 'realtime-err-adapter-version-skew',
		help: 'docs/errors.md#realtime-err-adapter-version-skew'
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
