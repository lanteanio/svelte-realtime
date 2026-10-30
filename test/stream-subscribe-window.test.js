// A stream subscribe registers the socket for the topic before its loader
// runs, and the response leaves only after the loader (in a batch, after every
// loader in the batch). The adapter client drops frames for a topic with no
// store, so a frame published in between survives only because the attach
// frame installs the stream's listener before the loader runs. These tests run
// the real client, the installed adapter client and the adapter's test server,
// park one loader of a batch, publish into the open window, and assert what
// the other stream shows.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { get } from 'svelte/store';
import { createTestServer } from 'svelte-adapter-uws/testing';
import { connect } from 'svelte-adapter-uws/client';
import { live, realtime, __register, _prepareHmr, _resetLifecycle } from '../src/server.js';
import { __stream } from '../src/client.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, what) {
	const end = Date.now() + 3000;
	while (!check()) {
		if (Date.now() >= end) throw new Error('Timed out waiting for ' + what);
		await sleep(5);
	}
}
function deferred() {
	let resolve;
	const promise = new Promise((done) => { resolve = done; });
	return { promise, resolve };
}

let seq = 0;

describe('stream subscribe window (real client, real adapter)', () => {
	let server, conn, gate, loaded;

	beforeAll(async () => {
		_resetLifecycle();
		server = await createTestServer({ handler: realtime() });
		conn = connect({ url: server.wsUrl });
	});

	afterAll(async () => {
		conn?.close();
		await server?.close();
		_prepareHmr();
	});

	beforeEach(() => {
		gate = deferred();
		loaded = new Set();
	});

	afterEach(() => gate.resolve());

	function register(n, merge) {
		const fastTopic = 'window:fast:' + n;
		const slowTopic = 'window:slow:' + n;
		const fast = merge === 'crud'
			? live.stream(fastTopic, async () => { loaded.add('fast'); return [{ id: 1, v: 'a' }]; }, { merge: 'crud', key: 'id' })
			: live.stream(fastTopic, async () => { loaded.add('fast'); return { v: 1 }; }, { merge: 'set' });
		__register('window' + n + '/fast', live.public(fast));
		__register('window' + n + '/slow', live.public(live.stream(slowTopic, async () => {
			loaded.add('slow');
			await gate.promise;
			return [];
		}, { merge: 'crud', key: 'id' })));
		return { fastTopic, fast: 'window' + n + '/fast', slow: 'window' + n + '/slow' };
	}

	it('a crud event published while a batch-mate loader is parked reaches the stream', async () => {
		const n = ++seq;
		const paths = register(n, 'crud');
		const fast = __stream(paths.fast, { merge: 'crud', key: 'id' });
		const slow = __stream(paths.slow, { merge: 'crud', key: 'id' });
		const offFast = fast.subscribe(() => {});
		const offSlow = slow.subscribe(() => {});

		// Both subscribes went out in one batch: the fast loader has read its
		// snapshot and the socket is on the topic, the response waits on slow.
		await until(() => loaded.has('fast') && loaded.has('slow'), 'both loaders');
		expect(server.platform.subscribers(paths.fastTopic)).toBe(1);
		expect(get(fast)).toBeUndefined();

		server.platform.publish(paths.fastTopic, 'created', { id: 2, v: 'b' });
		await sleep(30);
		gate.resolve();

		await until(() => Array.isArray(get(fast)), 'fast snapshot');
		await sleep(30);
		expect(get(fast)).toEqual([{ id: 1, v: 'a' }, { id: 2, v: 'b' }]);
		offFast();
		offSlow();
	});

	it('a set value published while a batch-mate loader is parked replaces the older snapshot', async () => {
		const n = ++seq;
		const paths = register(n, 'set');
		const fast = __stream(paths.fast, { merge: 'set' });
		const slow = __stream(paths.slow, { merge: 'crud', key: 'id' });
		const offFast = fast.subscribe(() => {});
		const offSlow = slow.subscribe(() => {});

		await until(() => loaded.has('fast') && loaded.has('slow'), 'both loaders');
		server.platform.publish(paths.fastTopic, 'set', { v: 2 });
		await sleep(30);
		gate.resolve();

		await until(() => get(fast) !== undefined, 'fast snapshot');
		await sleep(30);
		expect(get(fast)).toEqual({ v: 2 });
		offFast();
		offSlow();
	});
});
