// Live module backing the queue-replay e2e tests. Exposes a single
// `todos` stream and a small set of RPCs the tests use to drive
// optimistic-mutation scenarios deterministically:
//
//   ok(todo)            - resolves immediately, does NOT publish
//   okWithPublish(todo) - publishes 'created' then resolves
//   fail()              - throws LiveError('TEST_FAIL')
//   block(token)        - returns a promise that resolves only when
//                         release(token) is called from another RPC
//   release(token)      - settles the matching blocked promise
//   reset()             - empties the server state and the block pool

import { live, LiveError } from 'svelte-realtime/server';

/** @type {Array<{ id: string, name: string }>} */
let _state = [];

/** @type {Map<string, { resolve: (v: any) => void, reject: (e: any) => void }>} */
const _blocked = new Map();

export const todos = live.stream('todos:e2e', (ctx) => _state, { merge: 'crud', key: 'id' });

export const ok = live(async (ctx, todo) => {
	return { id: todo.id, server: true, name: todo.name };
});

export const okWithPublish = live(async (ctx, todo) => {
	const confirmed = { id: todo.id, name: 'Confirmed:' + todo.name };
	const idx = _state.findIndex((t) => t.id === confirmed.id);
	if (idx >= 0) _state[idx] = confirmed;
	else _state.push(confirmed);
	ctx.publish('todos:e2e', 'created', confirmed);
	return confirmed;
});

export const fail = live(async () => {
	throw new LiveError('TEST_FAIL', 'mutate-fail intentional');
});

export const block = live(async (ctx, body) => {
	const token = body.token;
	const settle = body.settle;
	return new Promise((resolve, reject) => {
		_blocked.set(token, { resolve, reject });
		if (settle === 'auto-resolve') queueMicrotask(() => {
			const w = _blocked.get(token);
			if (w) { _blocked.delete(token); w.resolve('ok'); }
		});
	});
});

export const release = live(async (ctx, body) => {
	const w = _blocked.get(body.token);
	if (!w) return { released: false };
	_blocked.delete(body.token);
	if (body.success === false) w.reject(new LiveError('TEST_FAIL', 'released as fail'));
	else w.resolve('released');
	return { released: true };
});

export const publishExternal = live(async (ctx, body) => {
	if (body.event === 'created' || body.event === 'updated') {
		const idx = _state.findIndex((t) => t.id === body.data.id);
		if (idx >= 0) _state[idx] = body.data;
		else _state.push(body.data);
	} else if (body.event === 'deleted') {
		const idx = _state.findIndex((t) => t.id === body.data.id);
		if (idx >= 0) _state.splice(idx, 1);
	}
	ctx.publish('todos:e2e', body.event, body.data);
	return { ok: true };
});

export const reset = live(async (ctx) => {
	_state = [];
	for (const w of _blocked.values()) w.reject(new LiveError('TEST_FAIL', 'reset'));
	_blocked.clear();
	// Publish a refreshed event so subscribed clients drop any state they
	// accumulated from prior test runs. Without this, the client's `todos`
	// store keeps the stale optimistic / server entries from the previous
	// test page until the next pub/sub event arrives.
	ctx.publish('todos:e2e', 'refreshed', []);
	return { ok: true };
});
