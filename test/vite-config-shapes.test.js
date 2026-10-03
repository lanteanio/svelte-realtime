import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { resolve } from 'path';
import { pathToFileURL } from 'url';
import svelteRealtime from '../src/vite.js';
import { _generateTypeDeclarations } from '../src/vite/codegen-types.js';
import { _skipNonCode } from '../src/vite/scanner.js';

// ---------------------------------------------------------------------------
// The client stub of a live.room() / live.multiplayer() export is generated
// from the config's source text, while the server builds the export from the
// evaluated config. These tests write configs in the shapes JavaScript allows -
// shorthand keys, spreads, consts named by identifier, methods - and check the
// generated stub against the export the same module produces at runtime.
// ---------------------------------------------------------------------------

const testRoot = resolve(import.meta.dirname, '__config_shape_fixtures__');
const liveDir = resolve(testRoot, 'src/live');
const SERVER_URL = pathToFileURL(resolve(import.meta.dirname, '..', 'src', 'server.js')).href;

let fileCounter = 0;

function setup(files) {
	mkdirSync(liveDir, { recursive: true });
	for (const [name, content] of Object.entries(files)) {
		writeFileSync(resolve(liveDir, name), content);
	}
}

afterEach(() => {
	if (existsSync(testRoot)) rmSync(testRoot, { recursive: true, force: true });
});

function createPlugin() {
	const plugin = svelteRealtime({ dir: 'src/live' });
	plugin.configResolved({ root: testRoot, build: {} });
	return plugin;
}

/**
 * Write `body` as a live module (with the live import prepended), generate its
 * client stub through the plugin, and import the module to get the exports the
 * server would register. Extra files (an imported config, say) go in `siblings`.
 */
async function generate(body, siblings = {}) {
	const mod = 'shape' + ++fileCounter;
	const source = `// realtime-allow-public\nimport { live } from ${JSON.stringify(SERVER_URL)};\n${body}`;
	setup({ ...siblings, [mod + '.js']: source });
	const stub = createPlugin().load('\0live:' + mod, {});
	const runtime = await import(pathToFileURL(resolve(liveDir, mod + '.js')).href);
	return { mod, stub, runtime };
}

/** The members the generated namespace `name` carries, read from the stub. */
function surface(stub, mod, name) {
	const has = (member, path) => stub.includes(`  ${member}: __stream(${JSON.stringify(mod + '/' + name + '/' + path)}`);
	// The export's own namespace block, so a sibling export's members never count.
	const lines = stub.split('\n');
	const first = lines.indexOf(`export const ${name} = {`);
	const block = first < 0 ? [] : lines.slice(first, lines.indexOf('};', first) + 1);
	const roomLine = block.find((l) => l.startsWith('  room(...args) {')) || '';
	const watchLine = block.find((l) => l.startsWith('  watch(...args) {')) || '';
	const actions = [];
	for (const line of block) {
		const m = line.match(new RegExp(`^  \\w+: __rpc\\("${mod}/${name}/__action/(\\w+)"\\)`));
		if (m) actions.push(m[1]);
	}
	return {
		presence: has('presence', '__presence'),
		owner: has('owner', '__owner'),
		cursors: has('cursors', '__cursors'),
		hasRoom: roomLine !== '',
		joins: roomLine.includes(`membership: ${name}.data(...args)`),
		watchJoins: watchLine.includes('membership:'),
		actions
	};
}

/** What the evaluated export carries, in the same terms. */
function runtimeSurface(exp) {
	return {
		presence: !!exp.__presenceStream,
		owner: !!exp.__hasOwner,
		cursors: !!exp.__cursorStream,
		actions: Object.keys(exp.__actions || {})
	};
}

/** The stub and the runtime export agree on every member the client wires. */
function expectAgreement(stub, mod, name, exp) {
	const s = surface(stub, mod, name);
	const r = runtimeSurface(exp);
	expect({ presence: s.presence, owner: s.owner, cursors: s.cursors, actions: s.actions }).toEqual(r);
	if (s.hasRoom) expect(s.joins).toBe(r.presence || r.owner);
	return s;
}

describe('live.multiplayer() config shapes', () => {
	it('reads a shorthand presence function, so room() joins', async () => {
		const { mod, stub, runtime } = await generate(`
const presence = (ctx) => ({ name: ctx.user.name });
export const board = live.multiplayer({
  topic: (ctx, id) => 'board:' + id,
  presence,
  cursors: true
});
`);
		const s = expectAgreement(stub, mod, 'board', runtime.board);
		expect(s.presence).toBe(true);
		expect(s.joins).toBe(true);
		expect(s.watchJoins).toBe(false);
	});

	it('reads a shorthand presence written as a function declaration', async () => {
		const { mod, stub, runtime } = await generate(`
function presence(ctx) { return { name: ctx.user.name }; }
export const board = live.multiplayer({ topic: (ctx, id) => 'board:' + id, presence });
`);
		const s = expectAgreement(stub, mod, 'board', runtime.board);
		expect(s.presence).toBe(true);
		expect(s.joins).toBe(true);
	});

	it('reads a shorthand owner through its const, on and off', async () => {
		const on = await generate(`
const owner = true;
export const board = live.multiplayer({ topic: (ctx, id) => 'board:' + id, owner, cursors: true });
`);
		const sOn = expectAgreement(on.stub, on.mod, 'board', on.runtime.board);
		expect(sOn.owner).toBe(true);
		expect(sOn.joins).toBe(true);

		const off = await generate(`
const owner = false;
export const board = live.multiplayer({ topic: (ctx, id) => 'board:' + id, owner, cursors: true });
`);
		const sOff = expectAgreement(off.stub, off.mod, 'board', off.runtime.board);
		expect(sOff.owner).toBe(false);
		expect(sOff.joins).toBe(false);
	});

	it('reads keys spread from a const object in the same module', async () => {
		const { mod, stub, runtime } = await generate(`
const shared = {
  presence: (ctx) => ({ name: ctx.user.name }),
  owner: true
};
export const board = live.multiplayer({ ...shared, topic: (ctx, id) => 'board:' + id, cursors: true });
`);
		const s = expectAgreement(stub, mod, 'board', runtime.board);
		expect(s.presence).toBe(true);
		expect(s.owner).toBe(true);
		expect(s.joins).toBe(true);
	});

	it('lets a later key override a spread one, as JavaScript does', async () => {
		const { mod, stub, runtime } = await generate(`
const defaults = { owner: true, cursors: true };
export const board = live.multiplayer({
  ...defaults,
  topic: (ctx, id) => 'board:' + id,
  presence: (ctx) => ({}),
  owner: false
});
`);
		const s = expectAgreement(stub, mod, 'board', runtime.board);
		expect(s.owner).toBe(false);
		expect(s.cursors).toBe(true);
	});

	it('lets a spread override a key written before it', async () => {
		const { mod, stub, runtime } = await generate(`
const ownerOn = { owner: true };
export const board = live.multiplayer({
  topic: (ctx, id) => 'board:' + id,
  cursors: true,
  owner: false,
  ...ownerOn
});
`);
		const s = expectAgreement(stub, mod, 'board', runtime.board);
		expect(s.owner).toBe(true);
		expect(s.joins).toBe(true);
	});

	it('joins when a computed key may name presence or owner', async () => {
		const { mod, stub, runtime } = await generate(`
const key = 'presence';
export const board = live.multiplayer({
  topic: (ctx, id) => 'board:' + id,
  cursors: true,
  [key]: (ctx) => ({ name: 'x' })
});
`);
		expect(runtime.board.__hasPresence).toBe(true);
		const s = surface(stub, mod, 'board');
		expect(s.joins).toBe(true);
	});

	it('joins when a followed spread itself spreads what the build cannot see', async () => {
		const { mod, stub, runtime } = await generate(`
import { base } from './base-config.js';
const shared = { ...base, cursors: true };
export const board = live.multiplayer({ ...shared, topic: (ctx, id) => 'board:' + id });
`, {
			'base-config.js': `export const base = { owner: true };\n`
		});
		expect(runtime.board.__hasOwner).toBe(true);
		const s = surface(stub, mod, 'board');
		expect(s.cursors).toBe(true);
		expect(s.joins).toBe(true);
	});

	it('reads declarations in a file written without semicolons', async () => {
		const { mod, stub, runtime } = await generate(`
const owner = false // kept off for now
const cursors = false
// cursors.enabled = true does nothing for a boolean
const note = 'owner.on = true is not code'
const presence = (ctx) => ({ name: ctx.user.name })
export const board = live.multiplayer({ topic: (ctx, id) => 'board:' + id, presence, owner, cursors })
`);
		const s = expectAgreement(stub, mod, 'board', runtime.board);
		expect(s.owner).toBe(false);
		expect(s.cursors).toBe(false);
		expect(s.presence).toBe(true);
	});

	it('does not read a same-named const inside a function as the module binding', async () => {
		const { mod, stub, runtime } = await generate(`
import { owner } from './owner-flag.js';
function local() { const owner = false; return owner; }
export const board = live.multiplayer({ topic: (ctx, id) => 'board:' + id, presence: (ctx) => ({}), owner });
void local;
`, {
			'owner-flag.js': `export const owner = true;\n`
		});
		const s = expectAgreement(stub, mod, 'board', runtime.board);
		expect(s.owner).toBe(true);
	});

	it('does not read an object literal that is only part of the expression', async () => {
		const { mod, stub, runtime } = await generate(`
const extra = { presence: (ctx) => ({ name: 'x' }) };
const shared = { owner: true } && extra;
export const board = live.multiplayer({ ...shared, topic: (ctx, id) => 'board:' + id, cursors: true });
`);
		// JavaScript spreads \`extra\`; the build cannot evaluate the expression,
		// so it reads neither object, and room() joins because the config is open.
		expect(runtime.board.__hasOwner).toBe(false);
		expect(runtime.board.__hasPresence).toBe(true);
		const s = surface(stub, mod, 'board');
		expect(s.owner).toBe(false);
		expect(s.presence).toBe(false);
		expect(s.joins).toBe(true);
	});

	it('stops following identifiers that name each other', () => {
		setup({
			'cycle.js': `
import { live } from 'svelte-realtime/server';
const a = b
const b = a
const off = false
export const board = live.multiplayer({ topic: (ctx, id) => 'board:' + id, presence: (ctx) => ({}), owner: a, cursors: off, ...b });
`
		});
		const s = surface(createPlugin().load('\0live:cycle', {}), 'cycle', 'board');
		// The cycle is unknown (on, and open); the declaration beside it still reads.
		expect(s.owner).toBe(true);
		expect(s.cursors).toBe(false);
		expect(s.joins).toBe(true);
	});

	it('reads each declarator of a declaration', async () => {
		const { mod, stub, runtime } = await generate(`
const cursors = false, owner = false, presence = (ctx) => ({ name: ctx.user.name });
export const board = live.multiplayer({ topic: (ctx, id) => 'board:' + id, presence, owner, cursors });
`);
		const s = expectAgreement(stub, mod, 'board', runtime.board);
		expect(s.presence).toBe(true);
		expect(s.owner).toBe(false);
		expect(s.cursors).toBe(false);
	});

	it('leaves a let the module assigns again unknown', async () => {
		const { mod, stub, runtime } = await generate(`
let cursorCfg = false;
if (typeof process !== 'undefined') ({ cursorCfg } = { cursorCfg: { throttle: 16 } });
export const board = live.multiplayer({ topic: (ctx, id) => 'board:' + id, presence: (ctx) => ({}), cursors: cursorCfg });
`);
		const s = expectAgreement(stub, mod, 'board', runtime.board);
		expect(s.cursors).toBe(true);
	});

	it('leaves a const object the module changes later unknown', async () => {
		const { mod, stub, runtime } = await generate(`
const shared = { owner: false };
shared.owner = true;
const flags = { owner: false };
Object.assign(flags, { owner: true });
export const board = live.multiplayer({ ...shared, topic: (ctx, id) => 'board:' + id, cursors: true });
export const pad = live.multiplayer({ ...flags, topic: (ctx, id) => 'pad:' + id, cursors: true });
`);
		// Read as written, both would be closed configs without an owner whose
		// room() never joins; the module turns the owner on, so they must join.
		for (const name of ['board', 'pad']) {
			expect(runtime[name].__hasOwner).toBe(true);
			expect(surface(stub, mod, name).joins).toBe(true);
		}
	});

	it('does not take reading a const object for changing it', async () => {
		const { mod, stub, runtime } = await generate(`
const shared = { owner: false, cursors: true, list: [] };
const isOwned = shared.owner === true || shared.owner !== false || shared.list.length >= 0;
for (const k in shared) void k;
shared.list.push(1);
// shared.owner = true once billing lands
const note = 'shared.owner = true is not code';
export const board = live.multiplayer({ ...shared, topic: (ctx, id) => 'board:' + id });
void isOwned;
void note;
`);
		const s = expectAgreement(stub, mod, 'board', runtime.board);
		expect(s.owner).toBe(false);
		expect(s.joins).toBe(false);
	});

	it('reads a config wrapped in a call as the object it is given, and as open', async () => {
		const { mod, stub, runtime } = await generate(`
const withDefaults = (config) => config;
export const pad = live.multiplayer(withDefaults({ topic: (ctx, id) => 'pad:' + id, cursors: true }));
export const notes = live.multiplayer(({ topic: (ctx, id) => 'notes:' + id, cursors: true }));
export const sketch = live.multiplayer({ ...withDefaults({ cursors: true }), topic: (ctx, id) => 'sketch:' + id });
`);
		const pad = surface(stub, mod, 'pad');
		expect(pad.cursors).toBe(true);
		expect(runtime.pad.__cursorStream).toBeTruthy();
		// The wrapper could add presence, so room() joins.
		expect(pad.joins).toBe(true);
		// A spread of a call is not guessed into: what the call returns is unknown,
		// so no roster key is readable and no room() is generated.
		const sketch = surface(stub, mod, 'sketch');
		expect(sketch.cursors).toBe(false);
		expect(sketch.hasRoom).toBe(false);
		// Parentheses change nothing: the config is read exactly.
		const notes = expectAgreement(stub, mod, 'notes', runtime.notes);
		expect(notes.joins).toBe(false);
	});

	it('generates no room() for an open config with no readable roster key', async () => {
		const { mod, stub } = await generate(`
import { shared } from './shared-roster.js';
export const board = live.multiplayer({ ...shared, topic: (ctx, id) => 'board:' + id });
`, {
			'shared-roster.js': `export const shared = { presence: (ctx) => ({ name: 'x' }) };\n`
		});
		// The client is generated from what the build can read; a room() whose
		// roster could never show anyone would fail quietly instead.
		expect(stub).toContain('export const board = {');
		expect(stub).toContain(`data: __stream("${mod}/board/__data"`);
		expect(surface(stub, mod, 'board').hasRoom).toBe(false);
	});

	it('leaves a presence field it cannot evaluate to the server, without a build error', async () => {
		const { mod, stub, runtime } = await generate(`
import { typing } from './typing-flag.js';
export const board = live.multiplayer({ topic: (ctx, id) => 'board:' + id, cursors: true, typing });
`, {
			'typing-flag.js': `export const typing = false;\n`
		});
		expect(runtime.board.__hasPresence).toBe(false);
		expect(surface(stub, mod, 'board').presence).toBe(false);
	});

	it('reads Object.assign as its arguments merged, and another call as the object written in it', async () => {
		const { mod, stub, runtime } = await generate(`
const base = { presence: (ctx) => ({ name: ctx.user.name }), owner: false };
const withLimits = (config, limits) => config;
export const board = live.multiplayer(Object.assign({}, base, { topic: (ctx, id) => 'board:' + id, owner: true }));
export const sketch = live.multiplayer(Object.assign({}, { topic: (ctx, id) => 'sketch:' + id, cursors: true }));
export const frozen = live.multiplayer(Object.freeze({ topic: (ctx, id) => 'frozen:' + id, cursors: true }));
const schema = { owner: true };
const defineRoom = (s, config) => config;
export const ruled = live.multiplayer(defineRoom(schema, { topic: (ctx, id) => 'ruled:' + id, presence: (ctx) => ({}) }));
export const pad = live.multiplayer(withLimits({
  topic: (ctx, id) => 'pad:' + id,
  topicArgs: 1,
  presence: (ctx) => ({}),
  actions: { rename: async () => null }
}, { actions: { perMinute: 30 } }));
`);
		const s = expectAgreement(stub, mod, 'board', runtime.board);
		expect(s.presence).toBe(true);
		expect(s.owner).toBe(true);
		// Every argument is visible, so the merged config is closed; so is a frozen one.
		const k = expectAgreement(stub, mod, 'sketch', runtime.sketch);
		expect(k.joins).toBe(false);
		expect(expectAgreement(stub, mod, 'frozen', runtime.frozen).joins).toBe(false);
		// The object written in the call is the config, not a const passed before it.
		const r = expectAgreement(stub, mod, 'ruled', runtime.ruled);
		expect(r.presence).toBe(true);
		expect(r.owner).toBe(false);
		// The config is the object written first; the options after it are not.
		const p = expectAgreement(stub, mod, 'pad', runtime.pad);
		expect(p.presence).toBe(true);
		expect(p.actions).toEqual(['rename']);
		expect(stub).not.toContain('perMinute');
	});

	it('reads curried, awaited and parenthesized configs', async () => {
		const { mod, stub, runtime } = await generate(`
const withX = (opts) => (config) => config;
const make = async (config) => config;
const config = { topic: (ctx, id) => 'c:' + id, presence: (ctx) => ({}), owner: true };
const base = { presence: (ctx) => ({}) };
const opts = { limit: 1 };
export const curried = live.multiplayer(withX(opts)({ topic: (ctx, id) => 'a:' + id, presence: (ctx) => ({}) }));
export const awaited = live.multiplayer(await make({ topic: (ctx, id) => 'b:' + id, owner: true, cursors: true }));
export const wrapped = live.multiplayer(/** @type {any} */ (config));
export const spread = live.multiplayer({ ...(base), topic: (ctx, id) => 'd:' + id, cursors: true });
const named = { topic: (ctx, id) => 'n:' + id, owner: true, cursors: true };
const limits = { perMinute: 30 };
const withLimits = (c, l) => c;
export const awaitedName = live.multiplayer(await make(named));
export const limited = live.multiplayer(withLimits(named, limits));
`);
		// A wrapper given a single const is read as that const.
		const a = surface(stub, mod, 'awaitedName');
		expect(a.owner).toBe(true);
		expect(a.cursors).toBe(true);
		// Which of several named arguments is the config is unknown: none is read.
		const l = surface(stub, mod, 'limited');
		expect(l.owner).toBe(false);
		expect(l.joins).toBe(false);
		expect(l.hasRoom).toBe(false);
		// A curried call is read from the first object written in it.
		expect(surface(stub, mod, 'curried').presence).toBe(true);
		expect(surface(stub, mod, 'curried').joins).toBe(true);
		expect(surface(stub, mod, 'awaited').owner).toBe(true);
		expect(surface(stub, mod, 'awaited').cursors).toBe(true);
		const w = expectAgreement(stub, mod, 'wrapped', runtime.wrapped);
		expect(w.presence).toBe(true);
		expect(w.owner).toBe(true);
		const s = expectAgreement(stub, mod, 'spread', runtime.spread);
		expect(s.presence).toBe(true);
	});

	it('fails the build on a template with interpolation reached through a spread, as when written in the call', () => {
		setup({
			'tpl.js': `
import { live } from 'svelte-realtime/server';
const ENTITY = 'card';
const base = { merge: 'crud', key: \`\${ENTITY}Id\` };
export const board = live.room({ ...base, topic: (ctx, id) => 'board:' + id, init: async () => [] });
`
		});
		expect(() => createPlugin().load('\0live:tpl', {})).toThrow(/Template literal/);
	});

	it('never emits an action named like a namespace member', () => {
		setup({
			'roles.js': `
import { live } from 'svelte-realtime/server';
const withRoles = (roles) => ({ archive: async () => null });
export const board = live.multiplayer({
  topic: (ctx, id) => 'board:' + id,
  presence: (ctx) => ({}),
  owner: true,
  actions: withRoles({ owner: ['admin'], data: ['admin'], room: ['admin'], admin: ['admin'] })
});
`
		});
		// Reading the wrapper's argument as the actions misreads the roles map;
		// the names that would replace namespace members are never emitted.
		const stub = createPlugin().load('\0live:roles', {});
		expect(surface(stub, 'roles', 'board').actions).toEqual(['admin']);
		expect(stub).not.toContain('__action/owner');
		expect(stub).not.toContain('__action/data');
		expect(stub).not.toContain('__action/room');
		expect(stub).toContain('owner: __stream("roles/board/__owner"');
		expect(stub).toContain('membership: board.data(...args)');
	});

	it('reads type arguments in TypeScript values without splitting members at their commas', () => {
		setup({
			'generic.ts': `
import { live } from 'svelte-realtime/server';
type Card = { id: string };
const withAudit = <C, T>(actions: T): T => actions;
const defineBoard = <A, B>(config: A): A => config;
export const board = live.multiplayer(defineBoard<Card, string>({
  topic: (ctx: any, id: string) => 'board:' + id,
  topicArgs: 1,
  init: async (): Promise<Map<string, Card>> => new Map(),
  cursors: true,
  actions: withAudit<any, Record<string, unknown>>({
    load: async (ctx: any, id: string): Promise<Map<string, Array<Card>>> => new Map(),
    rename: async (ctx: any, id: string, t: string) => t,
    pick<K extends string, V>(ctx: any, id: string, k: K): V | null { return null; }
  })
}));
const cache = new Map<string, number>(), owner = false;
export const pad = live.multiplayer({
  topic: (ctx: any, id: string) => 'pad:' + id,
  init: async (): Promise<Map<string, Card>> => new Map(),
  cursors: true,
  owner
});
`
		});
		const stub = createPlugin().load('\0live:generic', {});
		const b = surface(stub, 'generic', 'board');
		expect(b.cursors).toBe(true);
		expect(b.actions).toEqual(['load', 'rename', 'pick']);
		// The wrapper may add keys, so room() joins; the plain config is closed.
		expect(b.joins).toBe(true);
		const p = surface(stub, 'generic', 'pad');
		expect(p.owner).toBe(false);
		expect(p.joins).toBe(false);
	});

	it('does not take presence as given from a field whose value it cannot read', async () => {
		const { mod, stub, runtime } = await generate(`
import { FEATURES } from './features.js';
const hooks = { onJoin: async () => {} };
import { serverOnly } from './server-only.js';
export const board = live.multiplayer({ ...serverOnly, ...hooks, topic: (ctx, id) => 'board:' + id, cursors: true, typing: FEATURES.typing });
`, {
			'features.js': `export const FEATURES = { typing: false };\n`,
			'server-only.js': `export const serverOnly = { history: undefined };\n`
		});
		expect(runtime.board.__hasPresence).toBe(false);
		const s = surface(stub, mod, 'board');
		expect(s.presence).toBe(false);
		expect(s.joins).toBe(true);
	});

	it('reads a config passed as a const identifier', async () => {
		const { mod, stub, runtime } = await generate(`
const presence = (ctx) => ({ name: ctx.user.name });
const config = { topic: (ctx, id) => 'board:' + id, presence, owner: true };
export const board = live.multiplayer(config);
`);
		const s = expectAgreement(stub, mod, 'board', runtime.board);
		expect(s.presence).toBe(true);
		expect(s.owner).toBe(true);
	});

	it('joins when a spread the build cannot follow may declare presence', async () => {
		const { mod, stub, runtime } = await generate(`
import { shared } from './shared-config.js';
export const board = live.multiplayer({ ...shared, topic: (ctx, id) => 'board:' + id, cursors: true });
`, {
			'shared-config.js': `export const shared = { presence: (ctx) => ({ name: 'x' }) };\n`
		});
		// The server has presence; the build cannot see it, so room() joins
		// rather than leaving every send from the room dropped.
		expect(runtime.board.__hasPresence).toBe(true);
		const s = surface(stub, mod, 'board');
		expect(s.hasRoom).toBe(true);
		expect(s.joins).toBe(true);
		expect(s.watchJoins).toBe(false);
	});

	it('does not join for a fully visible config with neither presence nor owner', async () => {
		const { mod, stub, runtime } = await generate(`
const hooks = { onJoin: async () => {} };
export const board = live.multiplayer({ ...hooks, topic: (ctx, id) => 'board:' + id, cursors: true });
`);
		const s = expectAgreement(stub, mod, 'board', runtime.board);
		expect(s.hasRoom).toBe(true);
		expect(s.joins).toBe(false);
	});

	it('accepts shorthand presence beside a presence field without the build error', async () => {
		const { mod, stub, runtime } = await generate(`
const presence = (ctx) => ({ name: ctx.user.name });
export const board = live.multiplayer({ topic: (ctx, id) => 'board:' + id, presence, typing: true, locks: ['title'] });
`);
		const s = expectAgreement(stub, mod, 'board', runtime.board);
		expect(s.presence).toBe(true);
		expect(stub).toContain('setTyping:');
		expect(stub).toContain('acquireLock:');
	});

	it('takes presence as given when a presence field sits beside a spread it cannot follow', async () => {
		const { mod, stub, runtime } = await generate(`
import { shared } from './shared-presence.js';
export const board = live.multiplayer({ ...shared, topic: (ctx, id) => 'board:' + id, typing: true });
`, {
			'shared-presence.js': `export const shared = { presence: (ctx) => ({ name: 'x' }) };\n`
		});
		// The server refuses a presence field without a presence function, so a
		// module that loads has one; the stub wires the roster for it.
		const s = expectAgreement(stub, mod, 'board', runtime.board);
		expect(s.presence).toBe(true);
		expect(s.joins).toBe(true);
	});

	it('still refuses a presence field when presence is spelled out as off', () => {
		setup({
			'nopresence.js': `
import { live } from 'svelte-realtime/server';
export const board = live.multiplayer({ topic: (ctx, id) => 'board:' + id, presence: null, typing: true });
`
		});
		expect(() => createPlugin().load('\0live:nopresence', {})).toThrow(/presence field/);
	});

	it('reads methods, quoted keys and accessor modifiers as declared keys', async () => {
		const { mod, stub, runtime } = await generate(`
export const board = live.multiplayer({
  topic(ctx, id) { return 'board:' + id; },
  async 'presence'(ctx) { return { name: ctx.user.name }; },
  get owner() { return true; }
});
`);
		const s = expectAgreement(stub, mod, 'board', runtime.board);
		expect(s.presence).toBe(true);
		expect(s.owner).toBe(true);
	});

	it('reads a flag through a comment and a TypeScript clause', () => {
		setup({
			'typed.ts': `
import { live } from 'svelte-realtime/server';
const shared: { owner: boolean } = { owner: true } as const;
const cursors = false satisfies boolean;
export const board = live.multiplayer({
  ...shared,
  topic: (ctx: any, id: string) => 'board:' + id,
  presence: (ctx: any) => ({}),
  cursors, // spelled out
  reactions: /* later */ false
});
`
		});
		const stub = createPlugin().load('\0live:typed', {});
		const s = surface(stub, 'typed', 'board');
		expect(s.owner).toBe(true);
		expect(s.cursors).toBe(false);
		expect(stub).not.toContain('__reactions');
	});
});

describe('live.multiplayer() action shapes', () => {
	it('generates a stub for shorthand, spread and const-object actions', async () => {
		const { mod, stub, runtime } = await generate(`
async function rename(ctx, id, title) { return title; }
const archive = async (ctx, id) => null;
const base = { pin: async (ctx, id) => null };
export const board = live.multiplayer({
  topic: (ctx, id) => 'board:' + id,
  topicArgs: 1,
  presence: (ctx) => ({}),
  actions: { ...base, rename, archive, async unpin(ctx, id) { return null; } }
});
const shared = { rename: async (ctx, id, t) => t };
export const list = live.multiplayer({ topic: (ctx, id) => 'list:' + id, topicArgs: 1, actions: shared });
`);
		const s = expectAgreement(stub, mod, 'board', runtime.board);
		expect(s.actions).toEqual(['pin', 'rename', 'archive', 'unpin']);
		const l = surface(stub, mod, 'list');
		expect(l.actions).toEqual(['rename']);
		expect(l.actions).toEqual(Object.keys(runtime.list.__actions));
	});

	it('takes no action name from a call inside an action value', async () => {
		const { mod, stub, runtime } = await generate(`
const withAudit = (fn) => fn;
export const board = live.multiplayer({
  topic: (ctx, id) => 'board:' + id,
  topicArgs: 1,
  actions: { rename: withAudit(async (ctx, id, t) => t), flag: cond() ? a : b }
});
function cond() { return true; }
async function a() {}
async function b() {}
`);
		const s = expectAgreement(stub, mod, 'board', runtime.board);
		expect(s.actions).toEqual(['rename', 'flag']);
	});

	it('reads actions and a config wrapped in calls', async () => {
		const { mod, stub, runtime } = await generate(`
const withDefaults = (config) => config;
const withAudit = (actions) => actions;
const save = async (ctx, id) => null;
export const board = live.room(withDefaults({
  topic: (ctx, id) => 'board:' + id,
  topicArgs: 1,
  init: async () => [],
  presence: (ctx) => ({}),
  cursors: true,
  actions: withAudit({ save, archive: async (ctx, id) => null })
}));
`);
		const s = expectAgreement(stub, mod, 'board', runtime.board);
		expect(s.presence).toBe(true);
		expect(s.cursors).toBe(true);
		expect(s.actions).toEqual(['save', 'archive']);
	});

	it('reads a regex written on the line after a comment', async () => {
		const { mod, stub, runtime } = await generate(`
export const board = live.multiplayer({
  topic: (ctx, id) => 'board:' + id,
  topicArgs: 1,
  presence: (ctx) => ({ name: ctx.user.name }),
  actions: {
    rename: async (ctx, id, title) => {
      const clean = title.replace(
        // drop quote characters
        /['"]/g,
        ''
      );
      return clean;
    },
    archive: async (ctx, id) => null
  }
});
`);
		const s = expectAgreement(stub, mod, 'board', runtime.board);
		expect(s.presence).toBe(true);
		expect(s.actions).toEqual(['rename', 'archive']);
	});

	it('keeps actions apart across a division and a comment', async () => {
		const { mod, stub, runtime } = await generate(`
const half = (n) => n / 2; // don't round
const owner = false;
export const board = live.multiplayer({
  topic: (ctx, id) => 'board:' + id,
  topicArgs: 1,
  presence: (ctx) => ({ name: ctx.user.name }),
  owner,
  guard: (ctx, path) => { if (typeof path === 'string' && !/^[\\w/.-]+$/.test(path)) throw new Error('FORBIDDEN'); },
  actions: {
    halve: async (ctx, id, n) => n / 2, // halve it
    double: async (ctx, id, n) => n * 2,
    third: async (ctx, id, n) => half(n) / 1.5
  }
});
`);
		const s = expectAgreement(stub, mod, 'board', runtime.board);
		expect(s.presence).toBe(true);
		expect(s.owner).toBe(false);
		expect(s.actions).toEqual(['halve', 'double', 'third']);
	});

	it('does not take a comparison written against a name for type arguments', async () => {
		const { mod, stub, runtime } = await generate(`
export const board = live.multiplayer({
  topic: (ctx, id) => 'board:' + id,
  topicArgs: 1,
  presence: (ctx) => ({ name: ctx.user.name }),
  cursors: true,
  actions: {
    canUndo: async (ctx, id, i) => i<10,
    stats: async (ctx, id, n) => ({ full: n >= 10, avg: n / 2 })
  }
});
export const list = live.multiplayer({
  topic: (ctx, id) => 'list:' + id,
  topicArgs: 1,
  presence: (ctx) => ({}),
  actions: {
    canUndo: async (ctx, id, i) => i<10,
    canRedo: async (ctx, id, i) => i >= 0,
    shift: async (ctx, id, n) => n<1 || n>>1,
    both: async (ctx, id, a, b) => a<b && b>(a),
    limit: async (ctx, id, a, b) => a<b, max: async (ctx, id, c, d) => c>(d)
  }
});
`);
		const b = expectAgreement(stub, mod, 'board', runtime.board);
		expect(b.presence).toBe(true);
		expect(b.cursors).toBe(true);
		expect(b.actions).toEqual(['canUndo', 'stats']);
		const l = expectAgreement(stub, mod, 'list', runtime.list);
		expect(l.actions).toEqual(['canUndo', 'canRedo', 'shift', 'both', 'limit', 'max']);
	});

	it('ends a comparison at a quoted key, a spread or the object it sits in', async () => {
		const { mod, stub, runtime } = await generate(`
const common = { leave: async (ctx, id) => null };
async function rename(ctx, id, t) { return t; }
export const board = live.multiplayer({
  topic: (ctx, id) => 'board:' + id,
  topicArgs: 1,
  presence: (ctx) => ({ name: ctx.user.name }),
  actions: {
    'low': async (ctx, id, n) => n<6,
    'isBest': async (ctx, id, s) => s > (s - 1),
    'lucky': async (ctx, id) => Math.random() > .9
  }
});
export const list = live.multiplayer({
  topic: (ctx, id) => 'list:' + id,
  topicArgs: 1,
  presence: (ctx) => ({}),
  actions: { low: async (ctx, id, n) => n<6, rename, ...common, 'lucky': async (ctx, id) => Math.random() > .9 }
});
`);
		expect(expectAgreement(stub, mod, 'board', runtime.board).actions).toEqual(['low', 'isBest', 'lucky']);
		expect(expectAgreement(stub, mod, 'list', runtime.list).actions).toEqual(['low', 'rename', 'leave', 'lucky']);
	});

	it('keeps a comparison inside its config in a file written without semicolons', async () => {
		const { mod, stub, runtime } = await generate(`
export const board = live.multiplayer({
  topic: (ctx, id) => 'board:' + id,
  topicArgs: 1,
  cursors: true,
  actions: { small: async (ctx, id, n) => n<6 }
})
export const later = Math.max(1, 2) > (0)
`);
		// Read exactly, the config is closed: no presence or owner, so no join.
		const s = expectAgreement(stub, mod, 'board', runtime.board);
		expect(s.cursors).toBe(true);
		expect(s.joins).toBe(false);
		expect(s.actions).toEqual(['small']);
	});

	it('reads TypeScript assertions and generic arrows whose type arguments hold commas', () => {
		setup({
			'assert.ts': `
import { live } from 'svelte-realtime/server';
type Fn = (ctx: any, id: string, ...a: any[]) => unknown;
type Cfg<A, B> = Record<string, unknown>;
const withDefaults = <T>(config: T): T => config;
export const board = live.multiplayer({
  topic: (ctx: any, id: string) => 'board:' + id,
  topicArgs: 1,
  presence: (ctx: any) => ({}),
  actions: <Record<string, Fn>>{
    pick: async <K extends string, V, D>(ctx: any, id: string, k: K, d: D): Promise<V | D> => d,
    rename: async (ctx: any, id: string, t: string) => t,
    archive: async (ctx: any, id: string) => null
  }
});
export const game = live.room(<Cfg<string, number>>{
  topic: (ctx: any, id: string) => 'game:' + id,
  init: async () => [],
  presence: (ctx: any) => ({}),
  cursors: true
});
export const pad = live.multiplayer(withDefaults(<Cfg<string, (x: number) => void>>{ topic: (ctx: any, id: string) => 'pad:' + id, owner: true, cursors: true }));
export const bare = live.multiplayer(<Cfg<string, number>>{ topic: (ctx: any, id: string) => 'bare:' + id, cursors: true });
`
		});
		const stub = createPlugin().load('\0live:assert', {});
		// The assertion is read through exactly: a closed config without presence or owner.
		const bare = surface(stub, 'assert', 'bare');
		expect(bare.cursors).toBe(true);
		expect(bare.joins).toBe(false);
		expect(surface(stub, 'assert', 'board').actions).toEqual(['pick', 'rename', 'archive']);
		const g = surface(stub, 'assert', 'game');
		expect(g.presence).toBe(true);
		expect(g.cursors).toBe(true);
		const p = surface(stub, 'assert', 'pad');
		expect(p.owner).toBe(true);
		expect(p.cursors).toBe(true);
	});

	it('does not count ?? or ?. in a comparison as the ? of a conditional type', async () => {
		const { mod, stub, runtime } = await generate(`
export const board = live.multiplayer({
  topic: (ctx, id) => 'board:' + id,
  topicArgs: 1,
  presence: (ctx) => ({}),
  actions: {
    small: async (ctx, id, n, lim) => n<lim ?? 6,
    big: async (ctx, id, x) => x > (0),
    under: async (ctx, id, n, o) => n<o?.max,
    over: async (ctx, id, x) => x > (1)
  }
});
`);
		expect(expectAgreement(stub, mod, 'board', runtime.board).actions).toEqual(['small', 'big', 'under', 'over']);
	});

	it('reads an object written in an expression it cannot otherwise follow, as open', async () => {
		const { mod, stub, runtime } = await generate(`
const dev = typeof process !== 'undefined';
const make = () => ({ with: (config) => config });
export const ternary = live.multiplayer(dev ? { topic: (ctx, id) => 't:' + id, presence: (ctx) => ({}) } : { topic: (ctx, id) => 't:' + id, presence: (ctx) => ({}) });
export const chained = live.multiplayer(make().with({ topic: (ctx, id) => 'c:' + id, owner: true, cursors: true }));
export const proxied = live.multiplayer({
  topic: (ctx, id) => 'p:' + id,
  topicArgs: 1,
  presence: (ctx) => ({}),
  actions: new Proxy({ rename: async () => null, archive: async () => null }, {})
});
export const computed = live.multiplayer({
  topic: (ctx, id) => 'f:' + id,
  topicArgs: 1,
  presence: (ctx) => ({}),
  actions: (() => ({ ghost: async () => null }))()
});
`);
		expect(expectAgreement(stub, mod, 'ternary', runtime.ternary).presence).toBe(true);
		const c = expectAgreement(stub, mod, 'chained', runtime.chained);
		expect(c.owner).toBe(true);
		expect(c.cursors).toBe(true);
		expect(expectAgreement(stub, mod, 'proxied', runtime.proxied).actions).toEqual(['rename', 'archive']);
		// An invoked arrow's result is the first object written in it.
		expect(expectAgreement(stub, mod, 'computed', runtime.computed).actions).toEqual(['ghost']);
	});

	it('reads a function result passed to a wrapper, and no key from a destructuring pattern', async () => {
		const { mod, stub, runtime } = await generate(`
const defineBoard = (fn) => fn({});
const withDb = (fn) => fn({});
const defs = [{ name: 'a', enabled: true, fn: async () => null }];
const PERIODS = [{ name: 'hourly', ms: 3600000 }];
export const board = live.multiplayer(defineBoard((helpers) => ({
  topic: (ctx, id) => 'board:' + id,
  topicArgs: 1,
  presence: (ctx) => ({ name: ctx.user.name }),
  cursors: true,
  actions: withDb((db) => ({ rename: async (ctx, id, t) => t }))
})));
export const list = live.multiplayer({
  topic: (ctx, id) => 'list:' + id,
  topicArgs: 1,
  presence: (ctx) => ({}),
  actions: Object.fromEntries(defs.filter(({ enabled }) => enabled).map((d) => [d.name, d.fn]))
});
export const deps = live.multiplayer({
  topic: (ctx, id) => 'deps:' + id,
  topicArgs: 1,
  presence: (ctx) => ({}),
  actions: withDb(({ db, log }) => ({ rename: async () => null }))
});
void PERIODS;
`);
		const b = surface(stub, mod, 'board');
		expect(runtime.board.__hasPresence).toBe(true);
		expect(b.presence).toBe(true);
		expect(b.cursors).toBe(true);
		expect(b.actions).toEqual(['rename']);
		// A destructuring pattern is not an object of keys.
		expect(surface(stub, mod, 'list').actions).toEqual([]);
		expect(surface(stub, mod, 'deps').actions).toEqual([]);
	});

	it('does not follow a named argument of a call it guesses into', () => {
		setup({
			'guess.js': `
import { live } from 'svelte-realtime/server';
const authOpts = { roles: ['admin'] };
const APP = 'app';
const cache = createCache({ key: \`\${APP}:boards\`, ttl: 60 });
const log = pino({ level: 'info', name: 'board' });
export const board = live.multiplayer(withAuth(authOpts, defineBoard({
  topic: (ctx, id) => 'board:' + id,
  presence: (ctx) => ({}),
  cursors: true
})));
export const cached = live.room(withCache(cache, boardConfig));
export const logged = live.room({ topic: (ctx, id) => 'logged:' + id, topicArgs: 1, init: async () => [], actions: withLogging(log, boardActions) });
export const spreadCache = live.room({ ...cacheConfig({ key: \`\${APP}:x\` }), topic: (ctx, id) => 's:' + id, init: async () => [] });
export const flagged = live.multiplayer({ ...(DEV ? { cursors: true } : {}), ...(FLAG && { owner: true }), topic: (ctx, id) => 'f:' + id });
export const cachedOnly = live.room(withCache(cache));
export const plain = live.multiplayer(make().with({ topic: (ctx, id) => 'p:' + id, cursors: true }));
`
		});
		const stub = createPlugin().load('\0live:guess', {});
		const b = surface(stub, 'guess', 'board');
		expect(b.presence).toBe(true);
		expect(b.cursors).toBe(true);
		// A guessed config may hold more than the build sees, so room() joins.
		const p = surface(stub, 'guess', 'plain');
		expect(p.cursors).toBe(true);
		expect(p.joins).toBe(true);
		expect(surface(stub, 'guess', 'logged').actions).toEqual([]);
		// A conditional spread is not guessed into.
		const f = surface(stub, 'guess', 'flagged');
		expect(f.cursors).toBe(false);
		expect(f.owner).toBe(false);
	});

	it('takes a template in a wrapper\'s const options as unknown, not a build error', () => {
		setup({
			'lenient.js': `
import { live } from 'svelte-realtime/server';
const APP = 'app';
const cacheOpts = { key: \`\${APP}:boards\`, merge: 'set', ttl: 60 };
export const board = live.room(withCache(cacheOpts));
`
		});
		let stub;
		expect(() => { stub = createPlugin().load('\0live:lenient', {}); }).not.toThrow();
		// The key stays the default; the readable merge mode is still read.
		expect(stub).toContain('data: __stream("lenient/board/__data", {"merge":"set"}');
		// An object written in the call - which the plugin always read - one that
		// declares a topic, in any form, or one that holds a part the build cannot
		// read may be the config: its template still fails the build.
		for (const config of [
			'withCache({ key: `${ENTITY}:x`, merge: \'set\' }, opts)',
			'defineRoom(\'board\', { init: async () => [], key: `${ENTITY}Id` })',
			'withDefaults({ topic: (ctx, id) => \'b:\' + id, init: async () => [], key: `${ENTITY}Id` })',
			'defineRoom(CardSchema, { topic, init: async () => [], key: `${ENTITY}Id` })',
			'withDefaults({ ...importedBase, key: `${ENTITY}Id` })'
		]) {
			setup({
				'lenient.js': `
import { live } from 'svelte-realtime/server';
const ENTITY = 'card';
const topic = (ctx, id) => 'b:' + id;
export const board = live.room(${config});
`
			});
			expect(() => createPlugin().load('\0live:lenient', {})).toThrow(/Template literal/);
		}
	});

	it('does not guess into what a name holds', () => {
		setup({
			'held.js': `
import { live } from 'svelte-realtime/server';
const schema = { owner: true };
const config = defineRoom(schema, { topic: (ctx, id) => 'b:' + id, presence: (ctx) => ({}), cursors: true });
const boardActions = crudActions({ table: 'cards', schema: CardSchema });
const actions = withRoles({ owner: ['admin'], data: ['admin'] });
const limited = withRateLimit(baseActions, { perMinute: 30 });
const windows = makeWindows({ tz: 'UTC' });
export const board = live.multiplayer(config);
export const cards = live.room({ topic: (ctx, id) => 'c:' + id, topicArgs: 1, init: async () => [], actions: boardActions });
export const roles = live.room({ topic: (ctx, id) => 'r:' + id, topicArgs: 1, init: async () => [], actions });
export const rated = live.room({ topic: (ctx, id) => 'x:' + id, topicArgs: 1, init: async () => [], actions: limited });
export const stats = live.aggregate('events', { count: { init: () => 0, reduce: (n) => n + 1 } }, { windows });
`
		});
		const stub = createPlugin().load('\0live:held', {});
		// A const may hold a schema, a client or options as well as a config.
		expect(surface(stub, 'held', 'board').hasRoom).toBe(false);
		for (const name of ['cards', 'roles', 'rated']) expect(surface(stub, 'held', name).actions).toEqual([]);
		expect(stub).toContain('data: __stream("held/roles/__data"');
		expect(stub).not.toContain('__window/');
	});

	it('does not count a presence field a later unreadable part may override', async () => {
		const { mod, stub, runtime } = await generate(`
import { flags } from './typing-flags.js';
export const board = live.multiplayer({ topic: (ctx, id) => 'b:' + id, cursors: true, typing: true, ...flags });
`, {
			'typing-flags.js': `export const flags = { typing: false };\n`
		});
		expect(runtime.board.__hasPresence).toBe(false);
		expect(surface(stub, mod, 'board').presence).toBe(false);
	});

	it('does not follow a name for actions in what may be a wrapper\'s options', () => {
		setup({
			'budgets.ts': `
import { live } from 'svelte-realtime/server';
type Budgets = Record<string, number>;
const budgets = { perMinute: 30, burst: 5 };
const boardConfig = { topic: (ctx: any, id: string) => 'b:' + id, topicArgs: 1, init: async () => [], actions: { rename: async (ctx: any, id: string, t: string) => t } };
export const board = live.room(withRateLimit({ actions: budgets }, boardConfig));
export const single = live.room(withRateLimit({ actions: budgets }));
export const cast = live.room(withRateLimit({ actions: budgets as Budgets }));
export const parens = live.room(withRateLimit({ actions: (budgets) }));
export const spread = live.room(withRateLimit({ actions: { ...budgets } }));
export const frozen = live.room(withRateLimit({ actions: Object.freeze(budgets) }));
export const written = live.room(withRateLimit({ actions: { slow: 1 } }));
`
		});
		const stub = createPlugin().load('\0live:budgets', {});
		for (const name of ['board', 'single', 'cast', 'parens', 'spread', 'frozen']) {
			expect(surface(stub, 'budgets', name).actions).toEqual([]);
		}
		// An object written there is read as it always was.
		expect(surface(stub, 'budgets', 'written').actions).toEqual(['slow']);
	});

	it('reads actions written in a guessed config the way the plugin always did', async () => {
		const { mod, stub, runtime } = await generate(`
const withTopic = (p, o) => ({ topic: (ctx, id) => p + ':' + id, topicArgs: 1, ...o });
const withAudit = (a) => a;
export const board = live.room(withTopic('board', {
  init: async () => [],
  actions: withAudit({ rename: async (ctx, id, t) => t })
}));
const defineRoom = (schema, config) => config;
const schema = { id: 'string' };
const boardActions = { archive: async (ctx, id) => null };
export const ruled = live.room(defineRoom(schema, { topic: (ctx, id) => 'r:' + id, topicArgs: 1, init: async () => [], actions: boardActions }));
`);
		expect(surface(stub, mod, 'board').actions).toEqual(Object.keys(runtime.board.__actions));
		expect(surface(stub, mod, 'board').actions).toEqual(['rename']);
		// A guessed config that declares a topic is the config: its actions name is followed.
		expect(surface(stub, mod, 'ruled').actions).toEqual(Object.keys(runtime.ruled.__actions));
		expect(surface(stub, mod, 'ruled').actions).toEqual(['archive']);
	});

	it('follows no name and no spread for actions in what may be a wrapper\'s options', () => {
		setup({
			'optspread.js': `
import { live } from 'svelte-realtime/server';
const burst = 5;
const budgets = { perMinute: 30 };
const rl = { actions: { perMinute: 30 } };
const boardConfig = { topic: (ctx, id) => 'b:' + id, topicArgs: 1, init: async () => [], actions: { rename: async () => null } };
export const shorthand = live.room(withRateLimit(boardConfig, { burst, actions: budgets }));
export const spread = live.room(withRateLimit({ ...rl }));
`
		});
		const stub = createPlugin().load('\0live:optspread', {});
		expect(surface(stub, 'optspread', 'shorthand').actions).toEqual([]);
		expect(surface(stub, 'optspread', 'spread').actions).toEqual([]);
	});

	it('does not read a call\'s dependencies as actions or windows', () => {
		setup({
			'deps.js': `
import { live } from 'svelte-realtime/server';
import { db } from './db.js';
const table = 'cards';
const tz = 'UTC';
export const cards = live.room({ topic: (ctx, id) => 'c:' + id, topicArgs: 1, init: async () => [], actions: crudActions({ db, table, data: db }) });
export const stats = live.aggregate('events', { count: { init: () => 0, reduce: (n) => n + 1 } }, { windows: makeWindows({ tz }) });
`
		});
		const stub = createPlugin().load('\0live:deps', {});
		// \`data: db\` is written out, so it is read as before; the shorthand dependencies are not.
		expect(surface(stub, 'deps', 'cards').actions).toEqual(['data']);
		expect(stub).not.toContain('__window/');
	});

	it('keeps a presence field stable past a shorthand in a guessed config', async () => {
		const { mod, stub, runtime } = await generate(`
const defineBoard = (name, config) => ({ topic: (ctx, id) => name + ':' + id, ...config });
const presence = (ctx) => ({ name: ctx.user.name });
export const board = live.multiplayer(defineBoard('board', { cursors: true, typing: true, presence }));
`);
		const s = expectAgreement(stub, mod, 'board', runtime.board);
		expect(s.presence).toBe(true);
		expect(s.joins).toBe(true);
	});

	it('reads a config built from many spreads of spreads without blowing up', () => {
		let decls = 'const s0 = { cursors: true };\n';
		// Six levels of ten spreads each: a million body reads without the cache.
		for (let i = 1; i <= 6; i++) decls += `const s${i} = { ${Array.from({ length: 10 }, () => `...s${i - 1}`).join(', ')} };\n`;
		setup({
			'fanout.js': `
import { live } from 'svelte-realtime/server';
${decls}
export const board = live.multiplayer({ ...s6, topic: (ctx, id) => 'b:' + id, presence: (ctx) => ({}) });
`
		});
		const t0 = Date.now();
		const s = surface(createPlugin().load('\0live:fanout', {}), 'fanout', 'board');
		expect(Date.now() - t0).toBeLessThan(2000);
		expect(s.cursors).toBe(true);
	});

	it('reads a primitive const whatever another scope writes through the same name', async () => {
		const { mod, stub, runtime } = await generate(`
const cursors = false;
function bump(cursors, k) { cursors[k] = 1; }
export const board = live.multiplayer({ topic: (ctx, id) => 'b:' + id, presence: (ctx) => ({}), cursors });
void bump;
`);
		const s = expectAgreement(stub, mod, 'board', runtime.board);
		expect(s.cursors).toBe(false);
	});

	it('keeps the place of an Object.assign argument it cannot read', async () => {
		const { mod, stub, runtime } = await generate(`
import { flags } from './assign-flags.js';
export const board = live.multiplayer(Object.assign({}, { topic: (ctx, id) => 'b:' + id, cursors: true, typing: true }, flags));
`, {
			'assign-flags.js': `export const flags = { typing: false };\n`
		});
		// The unreadable argument comes after typing and may turn it off.
		expect(runtime.board.__hasPresence).toBe(false);
		expect(surface(stub, mod, 'board').presence).toBe(false);
		setup({
			'assigntpl.js': `
import { live } from 'svelte-realtime/server';
import { importedBase } from './base.js';
const E = 'card';
export const board = live.room(withDefaults(Object.assign({}, importedBase, { key: \`\${E}Id\` })));
`
		});
		// A part the build cannot read may hold the topic: the template fails the build.
		expect(() => createPlugin().load('\0live:assigntpl', {})).toThrow(/Template literal/);
	});

	it('counts a presence field after the opaque part of a spread object as stable', async () => {
		const { mod, stub, runtime } = await generate(`
import { imported } from './imported-presence.js';
const shared = { ...imported, typing: true };
export const board = live.multiplayer({ ...shared, topic: (ctx, id) => 'b:' + id });
`, {
			'imported-presence.js': `export const imported = { presence: (ctx) => ({ name: 'x' }) };\n`
		});
		const s = expectAgreement(stub, mod, 'board', runtime.board);
		expect(s.presence).toBe(true);
		expect(s.joins).toBe(true);
	});

	it('takes presence as given beside a presence field in a wrapper', () => {
		setup({
			'wrapfield.js': `
import { live } from 'svelte-realtime/server';
export const board = live.multiplayer(withPresence({ topic: (ctx, id) => 'b:' + id, typing: true }));
`
		});
		const s = surface(createPlugin().load('\0live:wrapfield', {}), 'wrapfield', 'board');
		expect(s.presence).toBe(true);
		expect(s.joins).toBe(true);
	});

	it('takes presence as given beside a presence field read through a binding or a spread', async () => {
		const { mod, stub, runtime } = await generate(`
function addPresence(c) { c.presence = (ctx) => ({ name: ctx.user.name }); }
const base = { typing: true };
addPresence(base);
const config = { topic: (ctx, id) => 'c:' + id, typing: true };
addPresence(config);
export const board = live.multiplayer({ ...base, topic: (ctx, id) => 'b:' + id });
export const named = live.multiplayer(config);
`);
		// The module can change what it spreads or names in ways the build cannot
		// see, and the server refuses a field without presence when it loads.
		for (const name of ['board', 'named']) {
			const s = expectAgreement(stub, mod, name, runtime[name]);
			expect(s.presence).toBe(true);
			expect(s.joins).toBe(true);
		}
		// A config written out in the call still gets the build error.
		setup({
			'plainfield.js': `
import { live } from 'svelte-realtime/server';
export const plain = live.multiplayer({ topic: (ctx, id) => 'p:' + id, typing: true });
`
		});
		expect(() => createPlugin().load('\0live:plainfield', {})).toThrow(/plain: live.multiplayer\(\) declares a presence field/);
	});

	it('does not read a call held in a const as a wrapper', () => {
		setup({
			'schema.js': `
import { live } from 'svelte-realtime/server';
const CardSchema = z.object({ id: z.string(), data: z.record(z.string()), done: z.boolean() });
const db = createClient({ url: process.env.DB_URL, authToken: process.env.DB_TOKEN });
const DocSchema = z.object({ owner: z.string() });
export const board = live.multiplayer({ topic: (ctx, id) => 'b:' + id, topicArgs: 1, presence: (ctx) => ({}), actions: crudActions(CardSchema) });
export const list = live.room({ topic: (ctx, id) => 'l:' + id, topicArgs: 1, init: async () => [], actions: makeActions(db) });
export const doc = live.multiplayer(defineBoard(DocSchema));
const presence = (ctx) => ({});
export const nested = live.multiplayer(withB(withA({ topic: (ctx, id) => 'n:' + id, presence, cursors: true })));
`
		});
		const stub = createPlugin().load('\0live:schema', {});
		expect(surface(stub, 'schema', 'board').actions).toEqual([]);
		expect(surface(stub, 'schema', 'list').actions).toEqual([]);
		expect(stub).toContain('data: __stream("schema/list/__data"');
		expect(surface(stub, 'schema', 'doc').owner).toBe(false);
		// Wrappers written out in the call are read through.
		const n = surface(stub, 'schema', 'nested');
		expect(n.presence).toBe(true);
		expect(n.cursors).toBe(true);
	});

	it('reads a wrapper through Object.freeze in either order', () => {
		setup({
			'frozen.js': `
import { live } from 'svelte-realtime/server';
const presence = (ctx) => ({});
export const outer = live.multiplayer(Object.freeze(withDefaults({ topic: (ctx, id) => 'o:' + id, presence, cursors: true })));
export const inner = live.multiplayer(withDefaults(Object.freeze({ topic: (ctx, id) => 'i:' + id, presence, cursors: true })));
`
		});
		const stub = createPlugin().load('\0live:frozen', {});
		for (const name of ['outer', 'inner']) {
			const s = surface(stub, 'frozen', name);
			expect(s.presence).toBe(true);
			expect(s.cursors).toBe(true);
		}
	});

	it('strips a TypeScript clause written straight after a closing brace', () => {
		setup({
			'clause.ts': `
import { live } from 'svelte-realtime/server';
type Cfg = Record<string, unknown>;
export const game = live.room({ topic: (ctx: any, id: string) => 'game:' + id, init: async () => [], presence: (ctx: any) => ({}), cursors: true }as Cfg);
export const pad = live.multiplayer({ topic: (ctx: any, id: string) => 'pad:' + id, cursors: true }satisfies Cfg);
`
		});
		const stub = createPlugin().load('\0live:clause', {});
		const g = surface(stub, 'clause', 'game');
		expect(g.presence).toBe(true);
		expect(g.cursors).toBe(true);
		// Read exactly: a closed config without presence or owner does not join.
		const p = surface(stub, 'clause', 'pad');
		expect(p.cursors).toBe(true);
		expect(p.joins).toBe(false);
	});

	it('leaves a spread of Object.assign open when one of its arguments cannot be read', async () => {
		const { mod, stub, runtime } = await generate(`
import { extra } from './assign-extra.js';
const base = { cursors: true };
export const board = live.multiplayer({ ...Object.assign({}, base, extra), topic: (ctx, id) => 'board:' + id });
`, {
			'assign-extra.js': `export const extra = { owner: true };\n`
		});
		expect(runtime.board.__hasOwner).toBe(true);
		const s = surface(stub, mod, 'board');
		expect(s.cursors).toBe(true);
		expect(s.joins).toBe(true);
	});

	it('reads TypeScript assertions followed by a call, generic functions and conditional type arguments', () => {
		setup({
			'asserted.ts': `
import { live } from 'svelte-realtime/server';
type Cfg = Record<string, unknown>;
type Fn = (ctx: any, id: string) => unknown;
const withDefaults = <T>(c: T): T => c;
const withAudit = <T>(a: T): T => a;
export const board = live.multiplayer(<Cfg>withDefaults({
  topic: (ctx: any, id: string) => 'board:' + id,
  topicArgs: 1,
  presence: (ctx: any) => ({}),
  cursors: true,
  actions: <Record<string, Fn>>withAudit({ rename: async () => null, archive: async () => null })
}));
export const pad = live.multiplayer({
  topic: (ctx: any, id: string) => 'pad:' + id,
  topicArgs: 1,
  presence: (ctx: any) => ({}),
  actions: {
    pick: async function <K, V, D>(ctx: any, id: string, k: K, d: D) { return d; },
    rename: async (ctx: any, id: string, t: string) => t
  }
});
export const cond = live.multiplayer(withDefaults<string extends string ? Cfg : never>({
  topic: (ctx: any, id: string) => 'cond:' + id,
  owner: true,
  cursors: true
}));
const named = { topic: (ctx: any, id: string) => 'named:' + id, owner: true, cursors: true };
export const assertedName = live.multiplayer(<Cfg>withDefaults(named));
export const condName = live.multiplayer(withDefaults<string extends string ? Cfg : never>(named));
`
		});
		const stub = createPlugin().load('\0live:asserted', {});
		// With no object written in the call, only following the names reads these.
		for (const name of ['assertedName', 'condName']) {
			const n = surface(stub, 'asserted', name);
			expect(n.owner).toBe(true);
			expect(n.cursors).toBe(true);
		}
		const b = surface(stub, 'asserted', 'board');
		expect(b.presence).toBe(true);
		expect(b.cursors).toBe(true);
		expect(b.actions).toEqual(['rename', 'archive']);
		expect(surface(stub, 'asserted', 'pad').actions).toEqual(['pick', 'rename']);
		const c = surface(stub, 'asserted', 'cond');
		expect(c.owner).toBe(true);
		expect(c.cursors).toBe(true);
	});

	it('reads a wrapper whose type arguments hold a function type', () => {
		setup({
			'fntype.ts': `
import { live } from 'svelte-realtime/server';
const withAudit = <T>(actions: T): T => actions;
export const board = live.multiplayer({
  topic: (ctx: any, id: string) => 'board:' + id,
  topicArgs: 1,
  presence: (ctx: any) => ({}),
  actions: withAudit<Record<string, (ctx: any, id: string) => Promise<unknown>>>({
    rename: async (ctx: any, id: string) => null,
    archive: async (ctx: any, id: string) => null
  })
});
`
		});
		const s = surface(createPlugin().load('\0live:fntype', {}), 'fntype', 'board');
		expect(s.actions).toEqual(['rename', 'archive']);
	});

	it('does not read a later object as the actions of an actions identifier it cannot see', async () => {
		const { mod, stub } = await generate(`
import { boardActions } from './board-actions.js';
export const board = live.multiplayer({
  topic: (ctx, id) => 'board:' + id,
  topicArgs: 1,
  actions: boardActions,
  presence: (ctx) => ({ name: ctx.user.name })
});
`, {
			'board-actions.js': `export const boardActions = { rename: async () => null };\n`
		});
		// The presence object's `name` is not an action.
		expect(surface(stub, mod, 'board').actions).toEqual([]);
		expect(stub).not.toContain('__action/name');
	});
});

describe('action names', () => {
	it('skips an action name that is not a valid path segment, with a warning', () => {
		setup({
			'named.js': `
import { live } from 'svelte-realtime/server';
export const board = live.multiplayer({
  topic: (ctx, id) => 'board:' + id,
  actions: { 'do-thing': async () => null, ok: async () => null }
});
`
		});
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			const s = surface(createPlugin().load('\0live:named', {}), 'named', 'board');
			expect(s.actions).toEqual(['ok']);
			expect(warn.mock.calls.some((c) => String(c[0]).includes("Action name 'do-thing'"))).toBe(true);
		} finally {
			warn.mockRestore();
		}
	});
});

describe('live.room() config shapes', () => {
	it('reads shorthand presence and owner and spread actions', async () => {
		const { mod, stub, runtime } = await generate(`
const presence = (ctx) => ({ name: ctx.user.name });
const owner = true;
const common = { leave: async (ctx, id) => null };
export const game = live.room({
  topic: (ctx, id) => 'game:' + id,
  topicArgs: 1,
  init: async () => [],
  presence,
  owner,
  actions: { ...common, move: async (ctx, id, pos) => pos }
});
export const lobby = live.room({
  topic: (ctx, id) => 'lobby:' + id,
  init: async () => [],
  presence: null,
  cursors: undefined
});
`);
		const s = expectAgreement(stub, mod, 'game', runtime.game);
		expect(s.presence).toBe(true);
		expect(s.owner).toBe(true);
		expect(s.actions).toEqual(['leave', 'move']);
		const l = expectAgreement(stub, mod, 'lobby', runtime.lobby);
		expect(l.presence).toBe(false);
		expect(l.cursors).toBe(false);
	});
});

describe('generated declarations follow the same reading', () => {
	it('types room() for a multiplayer export whose presence is shorthand', () => {
		setup({
			'typed.js': `
import { live } from 'svelte-realtime/server';
const presence = (ctx) => ({ name: ctx.user.name });
export const board = live.multiplayer({ topic: (ctx, id) => 'board:' + id, presence });
`
		});
		const dts = _generateTypeDeclarations(liveDir, 'src/live');
		expect(dts).toContain("room: (...args: any[]) => import('svelte-realtime/multiplayer').MultiplayerRoom");
	});

	it('generates the SSR stub roster for shorthand presence', () => {
		setup({
			'ssr.js': `
import { live } from 'svelte-realtime/server';
const presence = (ctx) => ({ name: ctx.user.name });
export const board = live.multiplayer({ topic: (ctx, id) => 'board:' + id, presence });
`
		});
		const plain = `
import { live } from 'svelte-realtime/server';
export const board = live.multiplayer({ topic: (ctx, id) => 'board:' + id, presence: (ctx) => ({ name: ctx.user.name }) });
`;
		const ssrShorthand = createPlugin().load('\0live:ssr', { ssr: true });
		setup({ 'ssr.js': plain });
		const ssrPlain = createPlugin().load('\0live:ssr', { ssr: true });
		expect(ssrShorthand).toBe(ssrPlain);
	});
});

describe('live.aggregate() window shapes', () => {
	it('reads windows after a division with a comment, and through Object.freeze', () => {
		setup({
			'rates.js': `
import { live } from 'svelte-realtime/server';
export const rates = live.aggregate('events', { count: { init: () => 0, reduce: (n) => n + 1 } }, {
  debounce: 1000 / 4, // four a second
  windows: Object.freeze({ hourly: { type: 'tumbling', durationMs: 3600000 } })
});
`
		});
		const stub = createPlugin().load('\0live:rates', {});
		expect(stub).toContain('"rates/rates/__window/hourly"');
	});

	it('reads windows given as a shorthand const object', () => {
		setup({
			'stats.js': `
import { live } from 'svelte-realtime/server';
const windows = { hourly: { type: 'tumbling', durationMs: 3600000 }, daily: { type: 'tumbling', durationMs: 86400000 } };
export const stats = live.aggregate('events', { count: { init: () => 0, reduce: (a) => a + 1 } }, { windows });
`
		});
		const stub = createPlugin().load('\0live:stats', {});
		expect(stub).toContain('"stats/stats/__window/hourly"');
		expect(stub).toContain('"stats/stats/__window/daily"');
	});
});

describe('regex literals and division in scanned source', () => {
	// _skipNonCode returns the index of the last character of a skipped regex,
	// or -1 when the `/` at i is not one.
	const at = (s) => s.indexOf('/');

	it('divides after a value, with or without spaces', () => {
		const cases = [
			'n / 2, // c', 'total/4, x', 'f(x) / 2 / 3', 'arr[0] / 2, b / c', '1000 / 4, // four',
			"x! / y // don't", 'i++ / 2, // c', 'stats.in/total, // c', 'a.of / 2, // c'
		];
		for (const s of cases) expect(_skipNonCode(s, at(s))).toBe(-1);
	});

	it('opens a regex where an expression starts', () => {
		const cases = [
			'x = /a,b/.test(y)', '(/a,b/)', 'f(a, /a,b/)', 'return /a,b/', '!/a,b/.test(p)', '/a,b/',
			'replace(\n  // drop\n  /a,b/g', 'if (ok) /a,b/.test(s)', 'while (x(y)) /a,b/.test(s)', 'export default /a,b/'
		];
		for (const s of cases) {
			const i = s.indexOf('/a,b/');
			expect(s[_skipNonCode(s, i)]).toBe('/');
			expect(_skipNonCode(s, i)).toBe(s.indexOf('/', i + 1));
		}
	});

	it('does not end a regex at a slash inside a character class', () => {
		const s = "if (!/^[\\w/.-]+$/.test(path)) throw e;";
		const i = at(s);
		expect(_skipNonCode(s, i)).toBe(s.indexOf('/.test'));
	});
});
