// live.push / live.notify topic target: broadcast-with-reply over the adapter's
// platform.requestTopic, aggregated to { replies, errors, count, delivered }.
// Uses a stub platform on state.cronPlatform - no adapter needed.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { live } from '../src/server.js';
import { state } from '../src/server/state.js';

describe('live.push / live.notify topic target', () => {
	let saved;
	beforeEach(() => { saved = state.cronPlatform; });
	afterEach(() => { state.cronPlatform = saved; });

	it('aggregates subscriber replies into { replies, errors, count, delivered }', async () => {
		state.cronPlatform = {
			requestTopic: async () => [
				{ ok: true, reply: { a: 1 } },
				{ ok: false, error: 'request timed out' },
				{ ok: true, reply: { b: 2 } }
			]
		};
		const out = await live.push({ topic: 'room:1' }, 'ping', { x: 1 });
		expect(out.replies).toEqual([{ a: 1 }, { b: 2 }]);
		expect(out.errors).toEqual([{ message: 'request timed out' }]);
		expect(out.count).toBe(3);
		expect(out.delivered).toBe(2);
	});

	it('passes topic / event / data / options through to platform.requestTopic', async () => {
		let seen;
		state.cronPlatform = { requestTopic: async (...args) => { seen = args; return []; } };
		await live.push({ topic: 'room:2' }, 'evt', { d: 1 }, { timeoutMs: 250 });
		expect(seen[0]).toBe('room:2');
		expect(seen[1]).toBe('evt');
		expect(seen[2]).toEqual({ d: 1 });
		expect(seen[3]).toEqual({ timeoutMs: 250 });
	});

	it('rejects VALIDATION when requestTopic is unavailable', async () => {
		state.cronPlatform = {}; // no requestTopic
		await expect(live.push({ topic: 'room' }, 'e', {})).rejects.toMatchObject({ code: 'VALIDATION' });
	});

	it('validates exactly-one-of userId / sessionId / topic', async () => {
		state.cronPlatform = { requestTopic: async () => [] };
		await expect(live.push({}, 'e', {})).rejects.toMatchObject({ code: 'VALIDATION' });
		await expect(live.push({ topic: 'r', userId: 'u' }, 'e', {})).rejects.toMatchObject({ code: 'VALIDATION' });
		await expect(live.push({ topic: '' }, 'e', {})).rejects.toMatchObject({ code: 'VALIDATION' });
		const err = await live.push({}, 'e', {}).catch((e) => e);
		expect(err.message).toMatch(/userId \/ sessionId \/ topic/);
	});

	it('notify({ topic }) fires a fire-and-forget broadcast and resolves to undefined', async () => {
		let called = false;
		state.cronPlatform = { requestTopic: () => { called = true; return Promise.resolve([]); } };
		await expect(live.notify({ topic: 'room' }, 'e', {})).resolves.toBeUndefined();
		expect(called).toBe(true);
	});
});
