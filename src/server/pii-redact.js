import { createHmac } from 'node:crypto';

/**
 * Default sensitive-key set stripped when redaction defaults are on. This is a
 * deliberate local copy of the same constant in the extensions package
 * (shared/sensitive.js): svelte-realtime never imports
 * svelte-adapter-uws-extensions (the package boundary runs the other way), and
 * a redaction default is a security constant worth keeping local and auditable
 * rather than coupling across independently-versioned packages. Excludes the
 * bare substring "key" because legitimate id-like fields often contain it.
 */
export const SENSITIVE_KEY_RE = /token|secret|password|auth|session|cookie|jwt|credential/i;

const MASK_TOKEN = '***';

/**
 * Build a UNIFORM PII redactor for a stream's wire egress. "Uniform" means the
 * same projection for every subscriber: redaction is applied once, before the
 * data reaches the replay buffer or the wire, so it composes with native
 * fan-out, replay (PII never rests in the buffer), and the cluster relay with
 * no per-subscriber machinery. Per-audience differences are expressed by
 * composing with `guard` + separate streams.
 *
 * The returned function is PURE and NON-MUTATING: it returns a redacted copy,
 * never altering the caller's object. This matters because a transform-less
 * stream hands its own data straight through (`wireData === data`), and that
 * object may also be retained by an app observer or read by `coalesceBy`.
 *
 * `config`:
 * - `true` - strip the default sensitive-key set (omit mode).
 * - `(data) => any` - a custom redactor, used as-is (the call site wraps it
 *   fail-closed). Use this for scalar payloads or bespoke shaping.
 * - `{ fields?, defaults?, hashSalt? }`:
 *   - `fields` - per-key mode map, matched by key NAME at ANY nesting depth,
 *     e.g. `{ email: 'mask', ssn: 'omit', userId: 'hash' }`.
 *   - `defaults` - also strip the sensitive-key set (default `true`; set
 *     `false` to apply ONLY the explicit fields). Explicit fields always win
 *     over the default strip.
 *   - `hashSalt` - required when any field uses `'hash'`; keys the HMAC so the
 *     pseudonym is stable across restarts and cluster instances yet not
 *     reversible without the salt.
 *
 * Modes: `omit` deletes the key; `mask` replaces the value with `'***'`
 * regardless of type; `hash` replaces it with a short HMAC-SHA256 pseudonym
 * (join-without-identity for analytics). Declarative field rules act on object
 * payloads; use a function redactor for scalar payloads.
 *
 * @param {true | ((data: any) => any) | { fields?: Record<string, 'omit' | 'mask' | 'hash'>, defaults?: boolean, hashSalt?: string }} config
 * @returns {(data: any) => any}
 */
export function createPiiRedactor(config) {
	if (config === true) {
		return (data) => _redactWalk(data, null, true, null, new WeakSet());
	}
	if (typeof config === 'function') {
		return config;
	}
	if (!config || typeof config !== 'object') {
		throw new Error("[svelte-realtime] piiRedact must be true, a function (data) => projection, or { fields, defaults, hashSalt }");
	}
	const fields = config.fields || null;
	const defaults = config.defaults !== false;
	const hashSalt = config.hashSalt;
	let needsHash = false;
	if (fields) {
		if (typeof fields !== 'object') {
			throw new Error("[svelte-realtime] piiRedact fields must be an object mapping field name to 'omit' | 'mask' | 'hash'");
		}
		for (const k of Object.keys(fields)) {
			const mode = fields[k];
			if (mode !== 'omit' && mode !== 'mask' && mode !== 'hash') {
				throw new Error("[svelte-realtime] piiRedact field '" + k + "' mode must be 'omit', 'mask', or 'hash'");
			}
			if (mode === 'hash') needsHash = true;
		}
	}
	if (needsHash && (typeof hashSalt !== 'string' || hashSalt.length === 0)) {
		throw new Error("[svelte-realtime] piiRedact 'hash' mode requires a non-empty hashSalt string (it keys the pseudonym so it is stable but not reversible)");
	}
	if (!fields && !defaults) {
		throw new Error("[svelte-realtime] piiRedact has no effect: enable defaults (sensitive-key strip) or provide fields");
	}
	return (data) => _redactWalk(data, fields, defaults, hashSalt, new WeakSet());
}

/**
 * Short keyed pseudonym for a value. HMAC (not a bare hash) so an attacker who
 * can enumerate candidate values (emails, ids) cannot recover the input without
 * the salt. 16 hex chars (64 bits) is ample for a stable join key.
 * @param {any} value
 * @param {string} salt
 */
function _hashValue(value, salt) {
	return createHmac('sha256', salt).update(String(value)).digest('hex').slice(0, 16);
}

/**
 * Cycle-safe, non-mutating recursive projection. Binary views become a
 * "[bytes: N]" placeholder so raw bytes (which may carry credentials) never
 * leak through a numeric-index walk. Mirrors the extensions stripInternal walk.
 * @param {any} value
 * @param {Record<string, 'omit' | 'mask' | 'hash'> | null} fields
 * @param {boolean} defaults
 * @param {string | null | undefined} salt
 * @param {WeakSet<object>} seen
 */
function _redactWalk(value, fields, defaults, salt, seen) {
	if (!value || typeof value !== 'object') return value;
	if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
		const len = /** @type {{ byteLength: number }} */ (value).byteLength;
		return '[bytes: ' + len + ']';
	}
	if (seen.has(value)) return undefined;
	seen.add(value);
	let result;
	if (Array.isArray(value)) {
		result = new Array(value.length);
		for (let i = 0; i < value.length; i++) {
			result[i] = _redactWalk(value[i], fields, defaults, salt, seen);
		}
	} else {
		result = {};
		for (const k of Object.keys(value)) {
			const mode = fields ? fields[k] : undefined;
			if (mode === 'omit') continue;
			if (mode === undefined && defaults && SENSITIVE_KEY_RE.test(k)) continue;
			if (mode === 'mask') { result[k] = MASK_TOKEN; continue; }
			if (mode === 'hash') { result[k] = _hashValue(value[k], salt); continue; }
			const v = value[k];
			result[k] = (v && typeof v === 'object') ? _redactWalk(v, fields, defaults, salt, seen) : v;
		}
	}
	seen.delete(value);
	return result;
}
