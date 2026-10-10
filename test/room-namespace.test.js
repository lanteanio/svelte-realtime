import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { live } from '../src/server.js';
import svelteRealtime from '../src/vite.js';

let fixture;
let members;
beforeAll(() => {
	fixture = mkdtempSync(join(import.meta.dirname, '__room_namespace_'));
	const liveDir = join(fixture, 'src/live');
	mkdirSync(liveDir, { recursive: true });
	writeFileSync(join(liveDir, 'collab.js'), `
import { live } from 'svelte-realtime/server';
// realtime-allow-public
export const board = live.room({
  topic: (ctx, id) => 'board:' + id,
  topicArgs: 1,
  init: async () => [],
  presence: (ctx) => ({ name: ctx.user.name }),
  cursors: true,
  owner: true,
  enumerable: true
});
`);
	const plugin = svelteRealtime({ dir: 'src/live' });
	plugin.configResolved({ root: fixture, build: {} });
	const code = plugin.load('\0live:collab', {});
	const body = code.slice(code.indexOf('export const board = {'));
	members = [...body.slice(0, body.indexOf('\n};')).matchAll(/^ {2}(\w+)(?::|\()/gm)].map(match => match[1]);
});
afterAll(() => {
	if (!fixture) return;
	if (dirname(resolve(fixture)) !== resolve(import.meta.dirname) || !basename(fixture).startsWith('__room_namespace_')) {
		throw new Error('Unsafe fixture directory');
	}
	rmSync(fixture, { recursive: true, force: true });
});

function room(actions, optional) {
	return live.room({
		topic: (ctx, id) => 'board:' + id,
		topicArgs: 1,
		init: async () => [],
		...(optional ? { presence: () => ({}), cursors: true, owner: true, enumerable: true } : {}),
		actions
	});
}

describe('room action namespace', () => {
	it.each([false, true])('rejects every generated member with optional surfaces enabled: %s', optional => {
		expect(members.sort()).toEqual(['cursors', 'data', 'owner', 'presence', 'rooms']);
		for (const name of members) {
			expect(() => room({ [name]: async () => null }, optional), name).toThrow(`action '${name}'`);
		}
	});
	it('rejects reserved own actions on callable action bags', () => {
		for (const name of members) {
			const actions = function actionBag() {};
			actions[name] = async () => null;
			expect(() => room(actions, false), name).toThrow(`action '${name}'`);
		}
	});
	it('keeps ordinary actions available', () => {
		const board = room({ addCard: async (ctx, id, title) => ({ id, title }) }, false);
		expect(board.__actions.addCard).toBeTypeOf('function');
	});
});
