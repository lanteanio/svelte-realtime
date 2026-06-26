// @ts-check
import { LiveError } from './live-error.js';

/**
 * Multi-tenancy scoping (`live.tenant` / `realtime({ tenant })`). Tenant
 * isolation is a SECURITY boundary, not a feature knob: when a tenant resolver
 * is configured, the framework derives a server-trusted tenant id for each
 * connection (`ctx.tenantId`) and auto-scopes every topic and key so two tenants
 * can never share a stream, presence roster, idempotency slot, lock, or replay
 * buffer. It is strictly OPT-IN - with no resolver every helper here is a single
 * null-check returning its input unchanged, so the single-tenant path is
 * byte-identical and zero-cost.
 *
 * The tenant id is NEVER read off the wire. It comes only from the resolver over
 * the authenticated `ctx.user` (= `ws.getUserData()`), the same server-trusted
 * identity the guard system already rests on.
 */

// Tenant ids are validated to this charset at the trust boundary so the prefix
// delimiters (`/` in topics, `\0` in keys) can never appear inside an id - that
// is what makes `tenantId + delimiter + rest` injection-safe (a tenant id with a
// raw delimiter could otherwise collide with another tenant's namespace).
const _VALID_TENANT_ID = /^[a-zA-Z0-9_-]+$/;

// Cap the tenant id length so the wire prefix `@t/<id>/` always leaves room under
// the adapter/bus 256-char topic cap on EVERY surface (a tenant id is a stable
// slug / UUID; 64 comfortably fits a UUID). Framework-internal id budgets (e.g.
// the room-enumeration id) reserve this worst case, so a tenant-scoped channel can
// never silently exceed the cap and have its cluster deltas dropped.
export const _MAX_TENANT_ID_LEN = 64;

// The reserved topic namespace for tenant-scoped wire topics. `@` is not `__`, so
// a scoped topic still passes the reserved-prefix guard and the cluster bus
// validator. Pure prepend, so it COMMUTES with suffixing (`prefix(X) + ':presence'
// === prefix(X + ':presence')`) - the property the room sub-topic derivation relies on.
const _TENANT_TOPIC_NS = '@t/';

/**
 * Validate a tenant id and return it, or throw a loud error. A misconfigured
 * resolver returning a bad id must FAIL (a silently-dropped id would disable
 * scoping = a leak), so this never returns null for a bad input.
 * @param {unknown} id
 * @returns {string}
 */
export function _validTenantId(id) {
	if (typeof id !== 'string' || !_VALID_TENANT_ID.test(id) || id.length > _MAX_TENANT_ID_LEN) {
		throw new LiveError(
			'VALIDATION',
			"tenant id must be a non-empty string of [a-zA-Z0-9_-], at most " + _MAX_TENANT_ID_LEN + " chars; got " + JSON.stringify(id) +
			'.\n  The tenant resolver and live.tenant(id) require a delimiter-safe, length-bounded id.\n  See: https://svti.me/tenant'
		);
	}
	return id;
}

/**
 * Global tenant-config registry (tenant id -> config object), populated by
 * `live.tenant(id, config)`. The realtime core does NOT enforce the config; it is
 * a forward-looking carrier consumed by the deferred quota / metrics / breaker
 * slices (extensions / adapter). Kept here so any consumer reads one source.
 * @type {Map<string, any>}
 * @internal
 */
export const _tenantConfigRegistry = new Map();

/**
 * Prefix a logical topic with the tenant namespace, or return it unchanged when
 * there is no tenant. `tenantId` is assumed already validated (the resolver /
 * handle validate at the boundary), so this stays a hot-path-cheap concat.
 * @param {string | null | undefined} tenantId
 * @param {string} topic
 * @returns {string}
 */
export function _tenantTopic(tenantId, topic) {
	return tenantId ? _TENANT_TOPIC_NS + tenantId + '/' + topic : topic;
}

/**
 * Prefix a derived key (idempotency / lock / roster) with the tenant, or return
 * it unchanged. The tenant segment is FIRST and `\0`-delimited; a validated id has
 * no `\0`, so the concatenation is unambiguous even when the rest of the key
 * contains colons (e.g. an IPv6 rate-limit key).
 * @param {string | null | undefined} tenantId
 * @param {string} key
 * @returns {string}
 */
export function _tenantKey(tenantId, key) {
	return tenantId ? tenantId + '\0' + key : key;
}

/**
 * Inverse of `_tenantTopic`: strip the tenant namespace from a WIRE topic back to
 * the logical topic. Returns the topic unchanged when there is no tenant or when
 * it does not carry this tenant's prefix (so it is safe to apply to an already-
 * logical topic). Used where framework code holds a wire topic but must surface
 * the logical one to the app - e.g. a room-enumeration snapshot entry - so the
 * single-tenant and multi-tenant shapes match. The round trip holds:
 * `_stripTenantTopic(id, _tenantTopic(id, x)) === x`.
 * @param {string | null | undefined} tenantId
 * @param {string} topic
 * @returns {string}
 */
export function _stripTenantTopic(tenantId, topic) {
	if (!tenantId) return topic;
	const prefix = _TENANT_TOPIC_NS + tenantId + '/';
	return typeof topic === 'string' && topic.startsWith(prefix) ? topic.slice(prefix.length) : topic;
}

/**
 * Strip the tenant prefix from a WIRE topic WITHOUT knowing the tenant id.
 * Used at publish chokepoints (e.g. redactor resolution) that hold the
 * tenant-scoped wire string but not the id: `@t/<id>/<logical>` -> `<logical>`.
 * Returns the topic unchanged when it carries no tenant prefix.
 *
 * @param {string} topic
 * @returns {string}
 */
export function _stripAnyTenantTopic(topic) {
	if (typeof topic !== 'string' || !topic.startsWith(_TENANT_TOPIC_NS)) return topic;
	const slash = topic.indexOf('/', _TENANT_TOPIC_NS.length);
	return slash === -1 ? topic : topic.slice(slash + 1);
}

/** The configured resolver, or null (opt-in: null = no tenancy = zero cost). */
let _tenantResolver = null;

/**
 * Install the tenant resolver. Called from `realtime({ tenant })`. Pass null to
 * disable. The resolver maps the authenticated user (ws.getUserData()) to a
 * tenant id string, or null/undefined for an unscoped connection.
 * @param {((user: any) => (string | null | undefined)) | null} fn
 */
export function _setTenantResolver(fn) {
	if (fn !== null && typeof fn !== 'function') {
		throw new LiveError('VALIDATION', 'realtime({ tenant }) must be a function (user) => id | null, or null to disable.');
	}
	_tenantResolver = fn;
}

/** Reset to the unscoped default (test helper). @internal */
export function _resetTenantResolver() {
	_tenantResolver = null;
}

/**
 * Resolve the server-trusted tenant id for a connection's user, or null when no
 * resolver is configured or the resolver returns no tenant. A non-null result is
 * validated (a bad id throws loudly rather than silently disabling scoping).
 * @param {any} user
 * @returns {string | null}
 */
export function _resolveTenant(user) {
	if (_tenantResolver === null) return null;
	const id = _tenantResolver(user);
	if (id === null || id === undefined) return null;
	return _validTenantId(id);
}

/**
 * A scoped publisher targeting a DIFFERENT tenant than the connection's own - the
 * explicit cross-tenant escape hatch (`ctx.tenant(otherId).publish(...)`), for
 * admin/system handlers that must publish into another tenant. Validates the
 * target id. Routes through the connection's internal wire-publish (`publishWire`
 * = the raw, non-prefixing `helpers.publish`), so cluster fan-out and replay
 * behave normally; the topic is prefixed for the TARGET tenant exactly once.
 * @param {(topic: string, event: string, data: any, options?: any) => any} publishWire
 * @param {unknown} id
 * @returns {{ tenantId: string, publish: (topic: string, event: string, data: any, options?: any) => any }}
 */
export function _makeTenantScope(publishWire, id) {
	const tenantId = _validTenantId(id);
	return {
		tenantId,
		publish(topic, event, data, options) {
			if (typeof topic === 'string' && topic.length >= 2 && topic.charCodeAt(0) === 95 && topic.charCodeAt(1) === 95) {
				throw new LiveError('INVALID_TOPIC', "tenant.publish() refuses '__'-prefixed topics (framework-internal channels).");
			}
			return publishWire(_tenantTopic(tenantId, topic), event, data, options);
		}
	};
}
