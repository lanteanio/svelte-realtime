// @ts-check

// Topic-path / identifier validators and the inbound-envelope depth guard.
// Pure: no module state, no imports. Shared by the dispatch and push/signal
// paths.

export const _validPathRe = /^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)+$/;
export const _validSegmentRe = /^[a-zA-Z0-9_]+$/;

/**
 * Max accepted length for a userId that flows into a topic name via
 * `__signal:${userId}` / `__push:${userId}` and similar server-built
 * system topics. 256 chars is generous for any realistic identifier
 * (UUIDs, opaque session tokens, prefixed-by-tenant ids) without
 * bloating log lines or stressing the adapter's wire-topic budget.
 */
export const _MAX_USER_ID_LENGTH = 256;

/**
 * Validate that a caller-supplied identifier is safe to interpolate into a
 * system topic name. Returns `null` if valid, otherwise a short error reason
 * string (prefixed with `label`) suitable for embedding in a thrown
 * LiveError / Error message.
 *
 * Server-side helpers that build `__signal:${id}` / `__push:${id}` topic names
 * from caller-supplied identifiers (userId, sessionId, ...) go through this gate
 * so malformed identifiers (control bytes, CR/LF, NUL, quotes, backslash, empty,
 * non-string, oversized) cannot poison the topic namespace, corrupt log lines, or
 * escape the system-topic prefix into the user-topic space. Non-ASCII bytes are
 * allowed for parity with the adapter's `allowNonAsciiTopics` opt-in; the server-
 * side builder trusts identifier shapes set by upgrade hooks.
 *
 * @param {unknown} value
 * @param {string} label the identifier kind, used in the error reason (e.g. 'userId')
 * @returns {string | null}
 */
export function _validIdReason(value, label) {
	if (typeof value !== 'string') return label + ' must be a string (got ' + (typeof value) + ')';
	if (value.length === 0) return label + ' must be non-empty';
	if (value.length > _MAX_USER_ID_LENGTH) return label + ' exceeds maximum length ' + _MAX_USER_ID_LENGTH + ' (got ' + value.length + ')';
	for (let i = 0; i < value.length; i++) {
		const c = value.charCodeAt(i);
		// Reject ASCII C0 controls (0x00-0x1F), DEL (0x7F), and the two
		// characters the adapter's wire-topic validator forbids:
		// 0x22 (double-quote), 0x5C (backslash).
		if (c < 0x20 || c === 0x7F || c === 0x22 || c === 0x5C) {
			return label + ' contains invalid character at index ' + i + ' (charCode ' + c + ')';
		}
	}
	return null;
}

/**
 * userId-labelled wrapper over {@link _validIdReason}, kept for the existing
 * call sites whose error wording is asserted.
 * @param {unknown} userId
 * @returns {string | null}
 */
export function _validUserIdReason(userId) {
	return _validIdReason(userId, 'userId');
}

/**
 * Default maximum nesting depth allowed in an inbound RPC envelope.
 * Anything deeper than this is rejected at ingress. 64 is well past any
 * realistic application shape (typical envelopes nest one or two levels
 * deep for `{args: [...]}` and an args payload) but well short of where
 * any host-app recursive walker would stack-overflow. Override per-call
 * via `handleRpc(ws, data, platform, { maxEnvelopeDepth })`.
 */
export const _DEFAULT_MAX_ENVELOPE_DEPTH = 64;

/**
 * Iterative depth walk over a parsed JSON value. Returns true when the
 * value (or any descendant) sits at a nesting depth greater than `max`.
 * Stack-based so a pathological depth cannot itself stack-overflow the
 * checker. Short-circuits on the first over-depth descendant found.
 *
 * @param {unknown} root
 * @param {number} max
 */
export function exceedsEnvelopeDepth(root, max) {
	if (root === null || typeof root !== 'object') return false;
	/** @type {Array<{ obj: any, depth: number }>} */
	const stack = [{ obj: root, depth: 1 }];
	while (stack.length > 0) {
		const { obj, depth } = /** @type {{ obj: any, depth: number }} */ (stack.pop());
		if (depth > max) return true;
		if (Array.isArray(obj)) {
			for (let i = 0; i < obj.length; i++) {
				const v = obj[i];
				if (v !== null && typeof v === 'object') stack.push({ obj: v, depth: depth + 1 });
			}
		} else {
			for (const k of Object.keys(obj)) {
				const v = obj[k];
				if (v !== null && typeof v === 'object') stack.push({ obj: v, depth: depth + 1 });
			}
		}
	}
	return false;
}
