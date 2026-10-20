import { afterEach, describe, expect, it } from 'vitest';
import { createTestServer, WS_SUBSCRIPTIONS } from 'svelte-adapter-uws/testing';
import { live, close, _resetCrdt, _resetSmooth } from '../src/server.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) {
	const deadline = Date.now() + 3000;
	while (!check()) {
		if (Date.now() > deadline) throw Error('Timed out waiting for subscription');
		await sleep(5);
	}
}
function deferred() {
	let resolve;
	const promise = new Promise(done => { resolve = done; });
	return { promise, resolve };
}
let server, client, native;
const gates = [];
async function start(hooks = {}) {
	server = await createTestServer({ handler: {
		open(ws) { native = ws; },
		close,
		...hooks
	} });
	client = new WebSocket(server.wsUrl);
	await new Promise((resolve, reject) => {
		client.addEventListener('open', resolve, { once: true });
		client.addEventListener('error', reject, { once: true });
	});
	await until(() => native);
	return { ws: native, user: native.getUserData(), platform: Object.create(server.platform, {
		subscribe: { value: undefined }, unsubscribe: { value: undefined }
	}) };
}
afterEach(async () => {
	for (const gate of gates.splice(0)) gate.resolve();
	client?.close();
	await server?.close();
	server = client = native = null;
	_resetCrdt();
	_resetSmooth();
});

describe('managed subscriptions without platform admission helpers', () => {
	it('releases the document registry entry only after its final mount closes', async () => {
		const ctx = await start();
		const doc = live.doc({ topic: 'tracked-document' });
		const topic = '__crdt:tracked-document';
		await doc.__docSync(ctx, [], 1);
		await doc.__docSync(ctx, [], 2);
		const registry = native.getUserData()[WS_SUBSCRIPTIONS];
		expect(native.isSubscribed(topic)).toBe(true);
		expect(registry.has(topic)).toBe(true);
		await doc.__docClose(ctx, 1);
		expect(native.isSubscribed(topic)).toBe(true);
		expect(registry.has(topic)).toBe(true);
		await doc.__docClose(ctx, 2);
		expect(native.isSubscribed(topic)).toBe(false);
		expect(registry.has(topic)).toBe(false);
		await doc.__docSync(ctx, [], 3);
		expect(native.isSubscribed(topic)).toBe(true);
		expect(registry.has(topic)).toBe(true);
	});

	for (const fallback of [true, false]) for (const resolvesDuringFailure of [true, false]) {
		it(`keeps independent pending admission alive after smooth initialization fails (fallback: ${fallback}, settles during failure: ${resolvesDuringFailure})`, async () => {
			const gate = deferred(); gates.push(gate);
			let calls = 0;
			const ctx = await start({ async subscribe() {
				if (++calls === 1) await gate.promise;
				return true;
			} });
			const topic = '__smooth:tracked-rollback';
			const admission = server.platform.subscribe(native, topic);
			await until(() => calls === 1);
			if (!fallback) ctx.platform = server.platform;
			const shape = live.smooth({ topic: 'tracked-rollback', initial() { if (resolvesDuringFailure) gate.resolve(); throw Error('seed refused'); }, apply: state => state });
			await expect(shape.__smoothSync(ctx)).rejects.toThrow('seed refused');
			if (!resolvesDuringFailure) {
				expect(native.isSubscribed(topic)).toBe(false);
				expect(native.getUserData()[WS_SUBSCRIPTIONS].has(topic)).toBe(false);
			}
			gate.resolve();
			expect(await admission).toBe(null);
			expect(native.isSubscribed(topic)).toBe(true);
			expect(native.getUserData()[WS_SUBSCRIPTIONS].has(topic)).toBe(true);
		});
	}
});
