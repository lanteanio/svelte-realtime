import { afterEach, expect, it } from 'vitest';
import { live, setBus, _prepareHmr } from '../src/server.js';
import { createTestEnv } from '../src/testing.js';

let env;
afterEach(() => { setBus(null); env?.cleanup(); _prepareHmr(); });

it.each([false, true])('reads current platform correlation on every reactive publish (batched: %s)', async batched => {
	env = createTestEnv();
	let active = { traceId: 'first-trace', requestId: 'first-request' };
	Object.defineProperties(env.platform, {
		traceContext: { enumerable: true, get() { return { traceId: active.traceId }; } },
		requestId: { enumerable: true, get() { return active.requestId; } }
	});
	const localPublish = env.platform.publish;
	env.platform.publishBatched = entries => {
		for (const entry of entries) localPublish(entry.topic, entry.event, entry.data, entry.options);
		return true;
	};
	const records = [];
	setBus({ wrap(platform) {
		const record = () => records.push({ traceId: platform.traceContext?.traceId, requestId: platform.requestId });
		return {
			publish(...args) { record(); return platform.publish(...args); },
			publishBatched(entries) { record(); return platform.publishBatched(entries); }
		};
	} });
	env.register('context', { feed: live.stream('context:feed', async () => [], { merge: 'latest' }) });
	const client = env.connect({ id: 'member' });
	const stream = client.subscribe('context/feed');
	await stream.waitFor(() => true);
	const publish = data => batched
		? env.platform.publishBatched([{ topic: 'context:feed', event: 'push', data }])
		: env.platform.publish('context:feed', 'push', data);
	publish({ id: 1 });
	active = { traceId: 'second-trace', requestId: 'second-request' };
	publish({ id: 2 });
	expect(stream.value).toEqual([{ id: 1 }, { id: 2 }]);
	expect(records).toEqual([
		{ traceId: 'first-trace', requestId: 'first-request' },
		{ traceId: 'second-trace', requestId: 'second-request' }
	]);
});
