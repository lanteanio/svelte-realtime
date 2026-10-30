import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockWs } from './helpers/mock-ws.js';
import { mockPlatform } from './helpers/mock-platform.js';

let server, state, tenant;
beforeEach(async () => {
	vi.resetModules();
	server = await import('../src/server.js');
	({ state } = await import('../src/server/state.js'));
	tenant = await import('../src/server/tenant.js');
});
afterEach(() => {
	tenant._resetTenantResolver();
	state.metricsInstruments = null;
	vi.restoreAllMocks();
});

function deferred() {
	let resolve;
	const promise = new Promise(done => { resolve = done; });
	return { promise, resolve };
}

// Legacy (no credit) upload chunk frame for upload/file.
function chunk(seq, bytes, isLast = false, streamId = 1) {
	const header = seq === 0 ? new TextEncoder().encode(JSON.stringify({ rpc: 'upload/file', args: [] })) : null;
	const start = header ? 12 + header.length : 10;
	const data = new Uint8Array(start + bytes);
	const view = new DataView(data.buffer);
	data[0] = 1; data[1] = (header ? 1 : 0) | (isLast ? 2 : 0);
	view.setUint32(2, streamId); view.setUint32(6, seq);
	if (header) { view.setUint16(10, header.length); data.set(header, 12); }
	return data.buffer;
}
function cancel(streamId = 1) {
	const data = new Uint8Array(6);
	data[0] = 2; data[1] = 0x10;
	new DataView(data.buffer).setUint32(2, streamId);
	return data.buffer;
}
const flush = () => new Promise(resolve => setTimeout(resolve, 0));

/** A handler that never reads its stream and ignores its abort signal until released. */
function stalledEndpoint(options) {
	const gate = deferred();
	let entered = 0;
	server.__register('upload/file', server.live.upload(async () => { entered++; await gate.promise; return 'done'; }, options));
	return { gate, entered: () => entered };
}

function replies(platform, code) {
	return platform.sent.filter(entry => entry.topic === '__upload' && entry.data.code === code).length;
}

describe('upload quotas spanning sessions', () => {
	for (const sessions of [100, 1000, 5000]) {
		it(`bounds one tenant opening a stalled upload on each of ${sessions} sessions`, async () => {
			tenant._setTenantResolver(user => user.tenant);
			const { gate, entered } = stalledEndpoint();
			const platform = mockPlatform();
			const sockets = [];
			try {
				for (let i = 0; i < sessions; i++) {
					const ws = mockWs({ id: 'u' + i, tenant: 'acme' });
					sockets.push(ws);
					server.handleRpc(ws, chunk(0, 16), platform);
				}
				await vi.waitFor(() => expect(entered() + replies(platform, 'TOO_MANY_UPLOADS')).toBe(sessions));
				expect(entered()).toBe(Math.min(sessions, 100));
				// Another tenant still uploads.
				const other = mockWs({ id: 'other', tenant: 'other' });
				sockets.push(other);
				server.handleRpc(other, chunk(0, 16), platform);
				await vi.waitFor(() => expect(entered()).toBe(Math.min(sessions, 100) + 1));
			} finally {
				gate.resolve();
				for (const ws of sockets) server.close(ws, { platform, subscriptions: [] });
			}
		});
	}

	it('bounds concurrent uploads per process without a tenant resolver', async () => {
		const { gate, entered } = stalledEndpoint();
		const platform = mockPlatform();
		const sockets = [];
		try {
			for (let i = 0; i < 1100; i++) {
				const ws = mockWs({ id: 'u' + i });
				sockets.push(ws);
				server.handleRpc(ws, chunk(0, 16), platform);
			}
			await vi.waitFor(() => expect(entered() + replies(platform, 'TOO_MANY_UPLOADS')).toBe(1100));
			expect(entered()).toBe(1000);
		} finally {
			gate.resolve();
			for (const ws of sockets) server.close(ws, { platform, subscriptions: [] });
		}
	});

	it('keeps the slot of a handler that ignores its abort signal until it returns', async () => {
		tenant._setTenantResolver(user => user.tenant);
		const { gate, entered } = stalledEndpoint({ maxConcurrentPerTenant: 2 });
		const platform = mockPlatform();
		const a = mockWs({ id: 'a', tenant: 'acme' }), b = mockWs({ id: 'b', tenant: 'acme' }), c = mockWs({ id: 'c', tenant: 'acme' });
		try {
			server.handleRpc(a, chunk(0, 16), platform);
			server.handleRpc(b, chunk(0, 16), platform);
			await vi.waitFor(() => expect(entered()).toBe(2));
			server.handleRpc(a, cancel(), platform);
			server.close(b, { platform, subscriptions: [] });
			server.handleRpc(c, chunk(0, 16), platform);
			await vi.waitFor(() => expect(replies(platform, 'TOO_MANY_UPLOADS')).toBe(1));
			gate.resolve(); await flush();
			server.handleRpc(c, chunk(0, 16, false, 2), platform);
			await vi.waitFor(() => expect(entered()).toBe(3));
		} finally {
			gate.resolve();
			for (const ws of [a, b, c]) server.close(ws, { platform, subscriptions: [] });
		}
	});

	it('bounds one user opening a stalled upload on each of many sessions', async () => {
		const { gate, entered } = stalledEndpoint();
		const platform = mockPlatform();
		const sockets = [];
		try {
			for (let i = 0; i < 300; i++) {
				const ws = mockWs({ id: 'mallory' });
				sockets.push(ws);
				server.handleRpc(ws, chunk(0, 16), platform);
			}
			await vi.waitFor(() => expect(entered() + replies(platform, 'TOO_MANY_UPLOADS')).toBe(300));
			expect(entered()).toBe(16);
			const other = mockWs({ id: 'alice' });
			sockets.push(other);
			server.handleRpc(other, chunk(0, 16), platform);
			await vi.waitFor(() => expect(entered()).toBe(17));
		} finally {
			gate.resolve();
			for (const ws of sockets) server.close(ws, { platform, subscriptions: [] });
		}
	});

	it('keeps counting a cancelled upload against its session until its handler returns', async () => {
		const { gate, entered } = stalledEndpoint({ maxConcurrentPerSession: 1 });
		const platform = mockPlatform();
		const ws = mockWs({ id: 'a' });
		try {
			server.handleRpc(ws, chunk(0, 16, false, 1), platform);
			await vi.waitFor(() => expect(entered()).toBe(1));
			server.handleRpc(ws, cancel(1), platform);
			server.handleRpc(ws, chunk(0, 16, false, 2), platform);
			await vi.waitFor(() => expect(replies(platform, 'TOO_MANY_UPLOADS')).toBe(1));
			expect(entered()).toBe(1);
			gate.resolve(); await flush();
			server.handleRpc(ws, chunk(0, 16, false, 3), platform);
			await vi.waitFor(() => expect(entered()).toBe(2));
		} finally {
			gate.resolve();
			server.close(ws, { platform, subscriptions: [] });
		}
	});

	it('counts the bytes queued before admission against the buffer quotas', async () => {
		tenant._setTenantResolver(user => user.tenant);
		const { gate, entered } = stalledEndpoint({ maxBufferedBytesPerTenant: 4096 });
		const platform = mockPlatform();
		const a = mockWs({ id: 'a', tenant: 'acme' }), b = mockWs({ id: 'b', tenant: 'acme' }), c = mockWs({ id: 'c', tenant: 'acme' });
		try {
			server.handleRpc(a, chunk(0, 8192), platform);
			await vi.waitFor(() => expect(replies(platform, 'OVERLOADED')).toBe(1));
			// A start chunk and a follow-on chunk queued while authorization runs.
			server.handleRpc(b, chunk(0, 2048), platform);
			server.handleRpc(b, chunk(1, 4096), platform);
			await vi.waitFor(() => expect(replies(platform, 'OVERLOADED')).toBe(2));
			expect(entered()).toBe(0);
			server.handleRpc(c, chunk(0, 4096), platform);
			await vi.waitFor(() => expect(entered()).toBe(1));
		} finally {
			gate.resolve();
			for (const ws of [a, b, c]) server.close(ws, { platform, subscriptions: [] });
		}
	});

	it('counts the bytes queued before admission against the process buffer quota', async () => {
		const { gate, entered } = stalledEndpoint({ maxBufferedBytesTotal: 4096 });
		const platform = mockPlatform();
		const a = mockWs({ id: 'a' });
		try {
			server.handleRpc(a, chunk(0, 8192), platform);
			await vi.waitFor(() => expect(replies(platform, 'OVERLOADED')).toBe(1));
			expect(entered()).toBe(0);
		} finally {
			gate.resolve();
			server.close(a, { platform, subscriptions: [] });
		}
	});

	it('bounds one tenant\'s unread buffered bytes across sessions', async () => {
		tenant._setTenantResolver(user => user.tenant);
		const { gate, entered } = stalledEndpoint({ maxBufferedBytesPerTenant: 64 * 1024 });
		const platform = mockPlatform();
		const a = mockWs({ id: 'a', tenant: 'acme' }), b = mockWs({ id: 'b', tenant: 'acme' });
		const c = mockWs({ id: 'c', tenant: 'acme' }), other = mockWs({ id: 'o', tenant: 'other' });
		try {
			server.handleRpc(a, chunk(0, 1024), platform);
			server.handleRpc(b, chunk(0, 0), platform);
			await vi.waitFor(() => expect(entered()).toBe(2));
			// a fills the tenant's 64 KiB; b's next chunk crosses it.
			for (let seq = 1; seq < 64; seq++) server.handleRpc(a, chunk(seq, 1024), platform);
			server.handleRpc(b, chunk(1, 1024), platform);
			expect(replies(platform, 'OVERLOADED')).toBe(1);
			expect(platform.sent.filter(entry => entry.data.code === 'OVERLOADED')[0].ws).toBe(b);
			// Refused at admission while the tenant is still full; other tenants are not.
			server.handleRpc(c, chunk(0, 16), platform);
			await vi.waitFor(() => expect(replies(platform, 'OVERLOADED')).toBe(2));
			expect(platform.sent.filter(entry => entry.data.code === 'OVERLOADED')[1].ws).toBe(c);
			server.handleRpc(other, chunk(0, 16), platform);
			await vi.waitFor(() => expect(entered()).toBe(3));
		} finally {
			gate.resolve();
			for (const ws of [a, b, c, other]) server.close(ws, { platform, subscriptions: [] });
		}
	});

	it('releases buffered bytes when the upload ends unread', async () => {
		tenant._setTenantResolver(user => user.tenant);
		const { gate, entered } = stalledEndpoint({ maxBufferedBytesPerTenant: 4096 });
		const platform = mockPlatform();
		const a = mockWs({ id: 'a', tenant: 'acme' }), b = mockWs({ id: 'b', tenant: 'acme' });
		try {
			server.handleRpc(a, chunk(0, 4096, true), platform);
			await vi.waitFor(() => expect(entered()).toBe(1));
			server.handleRpc(b, chunk(0, 16), platform);
			await vi.waitFor(() => expect(replies(platform, 'OVERLOADED')).toBe(1));
			gate.resolve();
			await vi.waitFor(() => expect(platform.sent.some(entry => entry.ws === a && entry.data.ok)).toBe(true));
			server.handleRpc(b, chunk(0, 16, false, 2), platform);
			await vi.waitFor(() => expect(entered()).toBe(2));
		} finally {
			gate.resolve();
			for (const ws of [a, b]) server.close(ws, { platform, subscriptions: [] });
		}
	});

	it('counts refusals by limit without labelling tenants', async () => {
		tenant._setTenantResolver(user => user.tenant);
		const limits = [];
		const noop = { inc() {}, observe() {}, set() {} };
		state.metricsInstruments = /** @type {any} */ (new Proxy({ uploadLimits: { inc: labels => limits.push(labels) } }, { get: (target, key) => key in target ? target[key] : noop }));
		const { gate, entered } = stalledEndpoint({ maxConcurrentPerTenant: 1 });
		const platform = mockPlatform();
		const a = mockWs({ id: 'a', tenant: 'acme' }), b = mockWs({ id: 'b', tenant: 'acme' });
		try {
			server.handleRpc(a, chunk(0, 16), platform);
			await vi.waitFor(() => expect(entered()).toBe(1));
			server.handleRpc(b, chunk(0, 16), platform);
			await vi.waitFor(() => expect(replies(platform, 'TOO_MANY_UPLOADS')).toBe(1));
			expect(limits).toEqual([{ limit: 'tenant' }]);
		} finally {
			gate.resolve();
			for (const ws of [a, b]) server.close(ws, { platform, subscriptions: [] });
		}
	});

	it('rejects a quota that is not a positive integer or Infinity', () => {
		for (const name of ['maxConcurrentPerUser', 'maxConcurrentPerTenant', 'maxConcurrentTotal', 'maxBufferedBytesPerTenant', 'maxBufferedBytesTotal']) {
			for (const value of [0, -1, 1.5, NaN, '10']) {
				expect(() => server.live.upload(async () => null, { [name]: value })).toThrow(name + ' must be a positive integer or Infinity');
			}
			expect(() => server.live.upload(async () => null, { [name]: Infinity })).not.toThrow();
		}
	});
});
