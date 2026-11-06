import { describe, it, expect } from 'vitest';
import { live, __register, handleRpc } from '../src/server.js';
import { mockWs } from './helpers/mock-ws.js';
import { mockPlatform } from './helpers/mock-platform.js';
import { toArrayBuffer } from './helpers/encode.js';

// A stream that resumes through delta.fromSeq numbers its events itself. On a
// platform that also has a replay buffer, the buffer's counter belongs to a
// different numbering, so it must never become this stream's cursor.
describe('delta.fromSeq resume cursor', () => {
	async function resume(name, fromSeq, bufferSeq) {
		const platform = mockPlatform();
		const counterCalls = [];
		platform.replay = { seq: async (topic) => { counterCalls.push(topic); return bufferSeq; }, since: async () => null };
		const stream = live.stream(name, async () => [{ id: 1 }], { merge: 'crud', key: 'id', delta: { fromSeq } });
		__register(name, stream);
		handleRpc(mockWs(), toArrayBuffer({ rpc: name, id: 'c1', args: [], stream: true, seq: 7 }), platform);
		await new Promise((r) => setTimeout(r, 10));
		return { response: platform.sent[0].data, counterCalls };
	}

	it.each([0, 99])('omits seq on an empty answer, whatever the buffer counter reads (%s)', async (bufferSeq) => {
		const { response, counterCalls } = await resume('fsc/empty-' + bufferSeq, async () => [], bufferSeq);
		expect(response.fromSeq).toBe(true);
		expect(response.data).toEqual([]);
		expect('seq' in response).toBe(false);
		expect(counterCalls).toEqual([]);
	});

	it('answers with the seq of the last numbered event', async () => {
		const events = [{ seq: 8, event: 'created', data: { id: 2 } }, { seq: 9, event: 'updated', data: { id: 2 } }];
		const { response, counterCalls } = await resume('fsc/events', async (from) => (from === 7 ? events : []), 99);
		expect(response.seq).toBe(9);
		expect(response.data).toEqual(events);
		expect(counterCalls).toEqual([]);
	});

	it('omits seq when the answered events carry no numbers', async () => {
		const { response } = await resume('fsc/unnumbered', async () => [{ event: 'created', data: { id: 3 } }], 99);
		expect('seq' in response).toBe(false);
	});
});
