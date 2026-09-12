#!/usr/bin/env node
/**
 * Pin the framework-internal publish choke point.
 *
 * The silent-topic dev watchdog asks "does this topic receive events", so every
 * framework publish that bypasses the ctx publish helper must pass through
 * `_platformPublish` (or call `_noteTopicPublish`) in src/server/publish-helpers.js.
 * A bare `<platform>.publish(...)` anywhere else is a topic the watchdog can never
 * see: an aggregate window output, a derived recompute, a cron tick, a stale
 * reload, all of which then warn about silence while publishing at full rate.
 *
 * Scope: the production runtime, src/server.js and src/server/**. What counts
 * as platform egress:
 * - a member call `<receiver>.publish(...)` / `<receiver>.batch(...)`, whether
 *   the member is spelled `.publish` or `['publish']`, on ANY receiver except
 *   the handler context `ctx` (which routes through the ctx helper), the ctx
 *   helper closures `helpers` / `scopedHelpers`, `this`, and, in
 *   src/server/replay-routing.js only, the replay extension `replay` (observed
 *   there before the hand-off). An alias such as `const cronPub =
 *   state.cronPlatform` is a receiver like any other and is caught; a call
 *   result as receiver (`scope(...).publish(...)`) is counted too and needs an
 *   allowed slot.
 * - a destructuring of `publish` off any object (`const { publish } = platform`),
 *   which would hide the call as a plain function call.
 *
 * Allowed bare call sites, pinned to an exact count:
 * - src/server/publish-helpers.js: the choke point itself.
 * - src/server/ctx.js: the ctx publish helper observes the topic at its own entry
 *   before choosing a route, so its direct egress branches are exempt, and the
 *   native batch route notes every topic before the hand-off.
 * - src/server.js: the tenant-scoped publish helper (a scoped ctx helper).
 *
 * The test and simulation harness (src/testing.js, src/sim.js) is out of scope
 * here because its platform is its own choke point: the harness platform's
 * `publish` observes the topic before fan-out.
 *
 * `publishWire` / `publishWireBatch` are not covered: they serve the reserved
 * `__smooth:` / `__crdt:` wire topics, which the watchdog skips by prefix.
 * `publishBatched` is reached only from the ctx helper, after its observation.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'acorn';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const serverRoot = join(root, 'src', 'server');
const methods = new Set(['publish', 'batch']);
const exemptReceivers = new Set(['ctx', 'helpers', 'scopedHelpers']);
const fileExemptReceivers = new Map([['src/server/replay-routing.js', new Set(['replay'])]]);
/** file -> method -> allowed bare call count */
const allowed = new Map([
	['src/server/publish-helpers.js', new Map([['publish', 1]])],
	['src/server/ctx.js', new Map([['publish', 3], ['batch', 1]])],
	['src/server.js', new Map([['publish', 1]])]
]);

function files(dir) {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const path = join(dir, entry.name);
		return entry.isDirectory() ? files(path) : entry.name.endsWith('.js') ? [path] : [];
	});
}
function walk(node, visit) {
	if (!node || typeof node !== 'object') return;
	visit(node);
	for (const value of Object.values(node)) {
		if (Array.isArray(value)) for (const child of value) walk(child, visit);
		else if (value && typeof value === 'object' && typeof value.type === 'string') walk(value, visit);
	}
}
/** The member name of a `.publish` / `.batch` / `['publish']` / `['batch']` access, else null. */
function egressMember(callee) {
	if (callee.type !== 'MemberExpression') return null;
	const { property, computed } = callee;
	if (!computed && property.type === 'Identifier' && methods.has(property.name)) return property.name;
	if (computed && property.type === 'Literal' && typeof property.value === 'string' && methods.has(property.value)) return property.value;
	return null;
}
/** The method name when `node` is a platform egress call in `rel`, else null. */
function platformEgress(node, rel) {
	if (node.type !== 'CallExpression') return null;
	const method = egressMember(node.callee);
	if (!method) return null;
	const object = node.callee.object;
	if (object.type === 'ThisExpression') return null;
	if (object.type === 'Identifier') {
		if (exemptReceivers.has(object.name)) return null;
		const perFile = fileExemptReceivers.get(rel);
		if (perFile && perFile.has(object.name)) return null;
	}
	return method;
}
/** `const { publish } = x`: a hidden egress alias. */
function hiddenDestructure(node) {
	if (node.type !== 'VariableDeclarator' || !node.id || node.id.type !== 'ObjectPattern') return null;
	for (const prop of node.id.properties) {
		if (prop.type !== 'Property') continue;
		const key = prop.key;
		const name = key.type === 'Identifier' ? key.name : (key.type === 'Literal' ? String(key.value) : null);
		// Only publish: a destructured batch is far more often the wire message's
		// batch array than a platform method.
		if (name === 'publish') return name;
	}
	return null;
}

const seen = new Map();
const failures = [];
let total = 0;
for (const path of [join(root, 'src', 'server.js'), ...files(serverRoot)]) {
	const rel = relative(root, path).split('\\').join('/');
	const source = readFileSync(path, 'utf8');
	const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module', locations: true });
	walk(ast, (node) => {
		const hidden = hiddenDestructure(node);
		if (hidden) failures.push(`${rel}:${node.loc.start.line} destructures .${hidden} off an object; call it as a member so the choke point can be checked`);
		const method = platformEgress(node, rel);
		if (!method) return;
		total++;
		if (!seen.has(rel)) seen.set(rel, new Map());
		const perFile = seen.get(rel);
		perFile.set(method, (perFile.get(method) || 0) + 1);
		if (!allowed.has(rel) || !allowed.get(rel).has(method)) {
			failures.push(`${rel}:${node.loc.start.line} bare .${method}() on a platform receiver; route it through _platformPublish() / _noteTopicPublish() in src/server/publish-helpers.js`);
		}
	});
}
for (const [rel, perMethod] of allowed) {
	for (const [method, count] of perMethod) {
		const actual = seen.get(rel)?.get(method) || 0;
		if (actual !== count) failures.push(`${rel}: expected exactly ${count} bare .${method}() call(s), found ${actual}`);
	}
}
if (failures.length > 0) {
	console.error('check-publish-routing FAILED:\n  ' + failures.join('\n  '));
	process.exit(1);
}
console.log(`check-publish-routing OK (${total} bare platform egress call(s), all at the allowed sites)`);
