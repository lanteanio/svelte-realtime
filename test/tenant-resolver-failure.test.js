import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';

const serverUrl = new URL('../src/server.js', import.meta.url).href;
const helpersUrl = new URL('./helpers/', import.meta.url).href;
const tenantUrl = new URL('../src/server/tenant.js', import.meta.url).href;
const admissionUrl = new URL('../src/server/rpc-admission.js', import.meta.url).href;

function run(program) {
	return spawnSync(process.execPath, ['--unhandled-rejections=strict', '--input-type=module', '-e', `
		import assert from 'node:assert/strict';
		import * as api from ${JSON.stringify(serverUrl)};
		import { _setTenantResolver } from ${JSON.stringify(tenantUrl)};
		import { _rpcAdmissionSnapshot } from ${JSON.stringify(admissionUrl)};
		import { mockWs } from ${JSON.stringify(helpersUrl + 'mock-ws.js')};
		import { mockPlatform } from ${JSON.stringify(helpersUrl + 'mock-platform.js')};
		import { toArrayBuffer } from ${JSON.stringify(helpersUrl + 'encode.js')};
		const flush = () => new Promise(resolve => setImmediate(resolve));
		const platform = mockPlatform();
		const diagnostics = [];
		api.setOperationalEventSink(record => diagnostics.push(record));
		${program}
	`], { encoding: 'utf8', timeout: 15000 });
}

function succeeded(result) {
	expect(result.error, result.stderr).toBeUndefined();
	expect(result.status, result.stderr).toBe(0);
}

describe('tenant resolver failures at RPC ingress', () => {
	for (const failure of ['context', 'dispatch']) {
		for (const sink of ['throw', 'reject']) {
			it(`contains ${failure} failure when the diagnostic sink ${sink}s and console fallback throws`, () => {
				succeeded(run(`
					api.setOperationalEventSink(() => { ${sink === 'throw' ? "throw new Error('Sink unavailable');" : "return Promise.reject(new Error('Sink unavailable'));"} });
					console.error = () => { throw new Error('Console unavailable'); };
					let invoked = 0;
					api.__register('tenant/failure', api.live(() => { invoked++; }));
					const ws = mockWs({ id: 'member' });
					${failure === 'context' ? "_setTenantResolver(() => { throw new Error('private/tenant-value'); });" : "ws.getUserData = () => { throw new Error('Socket unavailable'); };"}
					assert.equal(api.handleRpc(ws, toArrayBuffer({ rpc: 'tenant/failure', id: 'failed' }), platform), true);
					for (let i = 0; i < 5; i++) await flush();
					assert.equal(invoked, 0);
					assert.equal(_rpcAdmissionSnapshot().active, 0);
				`));
			});
		}
	}
	for (const mode of ['json', 'binary', 'parallel', 'sequential', 'volatile']) {
		for (const failure of ['throw', 'invalid']) {
			it(`contains ${failure} for ${mode} calls without leaking permits or tenant values`, () => {
				succeeded(run(`
					let broken = true, invoked = 0;
					const secret = 'private/tenant-value';
					_setTenantResolver(() => { if (!broken) return 'safe'; ${failure === 'throw' ? "throw new Error(secret);" : 'return secret;'} });
					const ws = mockWs({ id: 'member' });
					api.__register('tenant/run', api.live(() => { invoked++; return 'healthy'; }));
					api.__register('tenant/binary', api.live.binary(() => { invoked++; return 'healthy'; }));
					api.__register('tenant/volatile', api.live.volatile(() => { invoked++; return 'healthy'; }));
					const call = { rpc: 'tenant/run', id: 'failed' };
					let frame;
					if (${JSON.stringify(mode)} === 'binary') {
						const header = new TextEncoder().encode(JSON.stringify({ rpc: 'tenant/binary', id: 'failed' }));
						const bytes = new Uint8Array(3 + header.length);
						new DataView(bytes.buffer).setUint16(1, header.length);
						bytes.set(header, 3); frame = bytes.buffer;
					} else if (['parallel', 'sequential'].includes(${JSON.stringify(mode)})) {
						frame = toArrayBuffer({ batch: [call, { ...call, id: 'failed-2' }], sequential: ${mode === 'sequential'} });
					} else if (${JSON.stringify(mode)} === 'volatile') frame = toArrayBuffer({ rpc: 'tenant/volatile' });
					else frame = toArrayBuffer(call);
					assert.equal(api.handleRpc(ws, frame, platform), true);
					for (let i = 0; i < 5; i++) await flush();
					assert.equal(invoked, 0);
					const frames = platform.sent.filter(row => row.topic === '__rpc');
					if (${JSON.stringify(mode)} === 'volatile') assert.equal(frames.length, 0);
					else {
						assert.equal(frames.length, 1);
						const results = frames[0].data.batch || [frames[0].data];
						assert.equal(results.length, ['parallel', 'sequential'].includes(${JSON.stringify(mode)}) ? 2 : 1);
						for (const result of results) {
							assert.equal(result.ok, false); assert.equal(result.code, 'INTERNAL_ERROR');
							assert.equal(result.error, 'Internal server error');
						}
					}
					assert.equal(JSON.stringify([...platform.sent, ...diagnostics]).includes(secret), false);
					assert.equal(diagnostics.some(record => record.event === 'rpc.context.failed'), true);
					assert.deepEqual([_rpcAdmissionSnapshot().active, _rpcAdmissionSnapshot().queued], [0, 0]);
					broken = false;
					api.handleRpc(ws, toArrayBuffer({ ...call, id: 'healthy' }), platform);
					for (let i = 0; i < 5; i++) await flush();
					assert.equal(invoked, 1);
					assert.equal(platform.sent.at(-1).data.data, 'healthy');
					assert.equal(_rpcAdmissionSnapshot().active, 0);
				`));
			});
		}
	}

	it.each(['throw', 'invalid'])('retains awaited direct-call rejection and fallback for %s', failure => {
		succeeded(run(`
			let invoked = 0;
			_setTenantResolver(() => { ${failure === 'throw' ? "throw new Error('private/tenant-value');" : "return 'private/tenant-value';"} });
			api.__register('tenant/direct', api.live(() => { invoked++; return 'forbidden'; }));
			await assert.rejects(api.__directCall('tenant/direct', [], platform, { user: {} }));
			let observed = 0;
			assert.equal(await api.__directCall('tenant/direct', [], platform, { user: {}, fallback: 'degraded', onError() { observed++; } }), 'degraded');
			assert.equal(observed, 1); assert.equal(invoked, 0);
		`));
	});

	it.each(['json', 'binary', 'parallel', 'sequential', 'volatile'])('observes a final dispatcher rejection for %s ingress', mode => {
		succeeded(run(`
			api.__register('tenant/run', api.live(() => 'healthy'));
			api.__register('tenant/binary', api.live.binary(() => 'healthy'));
			const ws = mockWs({ id: 'member' });
			ws.getUserData = () => { throw new Error('private/identity-value'); };
			let frame;
			if (${JSON.stringify(mode)} === 'binary') {
				const header = new TextEncoder().encode(JSON.stringify({ rpc: 'tenant/binary', id: 'failed' }));
				const bytes = new Uint8Array(3 + header.length);
				new DataView(bytes.buffer).setUint16(1, header.length);
				bytes.set(header, 3); frame = bytes.buffer;
			} else if (['parallel', 'sequential'].includes(${JSON.stringify(mode)})) frame = toArrayBuffer({ batch: [{ rpc: 'tenant/run', id: 'failed' }], sequential: ${mode === 'sequential'} });
			else frame = toArrayBuffer({ rpc: 'tenant/run', ...(${JSON.stringify(mode)} === 'volatile' ? {} : { id: 'failed' }) });
			api.handleRpc(ws, frame, platform);
			for (let i = 0; i < 5; i++) await flush();
			assert.equal(diagnostics.some(record => record.event === 'rpc.dispatch.failed'), true);
			assert.equal(JSON.stringify(diagnostics).includes('private/identity-value'), false);
			assert.equal(platform.sent.length, 0);
			assert.equal(_rpcAdmissionSnapshot().active, 0);
		`));
	});

	it('observes throwing delivery and a rejecting context-error observer', () => {
		succeeded(run(`
			_setTenantResolver(() => { throw new Error('private/tenant-value'); });
			api.__register('tenant/run', api.live(() => assert.fail('handler must not run')));
			platform.send = () => { throw new Error('Delivery failed'); };
			api.handleRpc(mockWs({ id: 'member' }), toArrayBuffer({ rpc: 'tenant/run', id: 'failed' }), platform, {
				onError() { return Promise.reject(new Error('private/observer-value')); }
			});
			for (let i = 0; i < 5; i++) await flush();
			assert.equal(diagnostics.some(record => record.event === 'rpc.context.failed'), true);
			assert.equal(diagnostics.filter(record => record.event === 'rpc.context.failed').length, 1);
			assert.equal(JSON.stringify(diagnostics).includes('private/'), false);
			assert.equal(_rpcAdmissionSnapshot().active, 0);
		`));
	});
});

describe('admission ownership without a socket open hook', () => {
	it.each(['scalar', 'binary'])('isolates %s calls when a first admission sees another socket slot', mode => {
		succeeded(run(`
			api.configureRpc({ perConnectionConcurrent: 2, timeout: 0 });
			const shared = { id: 'member' };
			const first = mockWs(shared), second = { ...mockWs({}), getUserData: () => shared };
			const signals = new Map(), releases = new Map();
			const hold = async (ctx, label) => {
				signals.set(label, ctx.abortSignal);
				await new Promise(resolve => releases.set(label, resolve));
				return label;
			};
			api.__register('tenant/owner-hold', api.live(hold));
			api.__register('tenant/owner-binary', api.live.binary((ctx, _payload, label) => hold(ctx, label)));
			let healthyRuns = 0;
			api.__register('tenant/owner-healthy', api.live(() => { healthyRuns++; return 'healthy'; }));
			const sendHold = (socket, label) => {
				let frame;
				if (${JSON.stringify(mode)} === 'binary') {
					const header = new TextEncoder().encode(JSON.stringify({ rpc: 'tenant/owner-binary', id: label, args: [label] }));
					const bytes = new Uint8Array(3 + header.length);
					new DataView(bytes.buffer).setUint16(1, header.length); bytes.set(header, 3); frame = bytes.buffer;
				} else frame = toArrayBuffer({ rpc: 'tenant/owner-hold', id: label, args: [label] });
				api.handleRpc(socket, frame, platform);
			};
			api.pushHooks.open(second, { platform });
			sendHold(first, 'first'); sendHold(second, 'second');
			for (let i = 0; i < 5; i++) await flush();
			assert.equal(signals.size, 2);
			api.close(first, { platform });
			assert.equal(signals.get('first').aborted, true);
			assert.equal(signals.get('second').aborted, false);
			api.handleRpc(first, toArrayBuffer({ rpc: 'tenant/owner-healthy', id: 'late-first' }), platform);
			api.handleRpc(second, toArrayBuffer({ rpc: 'tenant/owner-healthy', id: 'live-second' }), platform);
			for (let i = 0; i < 5; i++) await flush();
			assert.equal(platform.sent.find(row => row.event === 'late-first')?.data.code, 'CONNECTION_CLOSED');
			assert.equal(platform.sent.find(row => row.event === 'live-second')?.data.data, 'healthy');
			assert.equal(healthyRuns, 1);
			api.close(second, { platform });
			assert.equal(signals.get('second').aborted, true);
			releases.get('first')(); releases.get('second')();
			for (let i = 0; i < 5; i++) await flush();
			assert.deepEqual([_rpcAdmissionSnapshot().active, _rpcAdmissionSnapshot().queued, _rpcAdmissionSnapshot().openSignals], [0, 0, 0]);
		`));
	});

	it('marks a never-admitted socket closed without closing another socket slot', () => {
		succeeded(run(`
			api.configureRpc({ perConnectionConcurrent: 2, timeout: 0 });
			const shared = { id: 'member' };
			const first = mockWs(shared), second = { ...mockWs({}), getUserData: () => shared };
			let signal, release, healthyRuns = 0;
			api.__register('tenant/owner-hold', api.live(async ctx => {
				signal = ctx.abortSignal;
				await new Promise(resolve => { release = resolve; });
				return 'finished';
			}));
			api.__register('tenant/owner-healthy', api.live(() => { healthyRuns++; return 'healthy'; }));
			api.pushHooks.open(second, { platform });
			api.handleRpc(second, toArrayBuffer({ rpc: 'tenant/owner-hold', id: 'second' }), platform);
			for (let i = 0; i < 5; i++) await flush();
			assert.equal(signal.aborted, false);
			api.close(first, { platform });
			assert.equal(signal.aborted, false);
			api.handleRpc(first, toArrayBuffer({ rpc: 'tenant/owner-healthy', id: 'late-first' }), platform);
			api.handleRpc(second, toArrayBuffer({ rpc: 'tenant/owner-healthy', id: 'live-second' }), platform);
			for (let i = 0; i < 5; i++) await flush();
			assert.equal(platform.sent.find(row => row.event === 'late-first')?.data.code, 'CONNECTION_CLOSED');
			assert.equal(platform.sent.find(row => row.event === 'live-second')?.data.data, 'healthy');
			assert.equal(healthyRuns, 1);
			api.close(second, { platform }); assert.equal(signal.aborted, true);
			release(); for (let i = 0; i < 5; i++) await flush();
			assert.deepEqual([_rpcAdmissionSnapshot().active, _rpcAdmissionSnapshot().queued, _rpcAdmissionSnapshot().openSignals], [0, 0, 0]);
		`));
	});

	it('removes a first queued admission without disturbing its shared-user socket', () => {
		succeeded(run(`
			api.configureRpc({ perConnectionConcurrent: 2, globalConcurrent: 1, timeout: 0 });
			const shared = { id: 'member' };
			const first = mockWs(shared), second = { ...mockWs({}), getUserData: () => shared };
			let signal, release, queuedRuns = 0;
			api.__register('tenant/owner-hold', api.live(async ctx => {
				signal = ctx.abortSignal;
				await new Promise(resolve => { release = resolve; });
				return 'finished';
			}));
			api.__register('tenant/owner-queued', api.live(() => { queuedRuns++; return 'queued'; }));
			api.pushHooks.open(second, { platform });
			api.handleRpc(second, toArrayBuffer({ rpc: 'tenant/owner-hold', id: 'second' }), platform);
			for (let i = 0; i < 5; i++) await flush();
			api.handleRpc(first, toArrayBuffer({ rpc: 'tenant/owner-queued', id: 'first' }), platform);
			for (let i = 0; i < 5; i++) await flush();
			assert.equal(_rpcAdmissionSnapshot().queued, 1);
			api.close(first, { platform });
			for (let i = 0; i < 5; i++) await flush();
			assert.equal(signal.aborted, false);
			assert.equal(_rpcAdmissionSnapshot().queued, 0);
			assert.equal(platform.sent.find(row => row.event === 'first')?.data.code, 'CONNECTION_CLOSED');
			release(); for (let i = 0; i < 5; i++) await flush();
			assert.equal(queuedRuns, 0);
			api.handleRpc(second, toArrayBuffer({ rpc: 'tenant/owner-queued', id: 'live-second' }), platform);
			for (let i = 0; i < 5; i++) await flush();
			assert.equal(platform.sent.find(row => row.event === 'live-second')?.data.data, 'queued');
			assert.equal(queuedRuns, 1);
			api.close(second, { platform });
			assert.deepEqual([_rpcAdmissionSnapshot().active, _rpcAdmissionSnapshot().queued, _rpcAdmissionSnapshot().openSignals], [0, 0, 0]);
		`));
	});
});

describe('tenant ownership during socket cleanup', () => {
	for (const mode of ['scalar', 'binary', 'queued-only']) {
		it.each([false, true])(`closes ${mode} admission without native user data (open hook=%s)`, opened => {
			succeeded(run(`
				api.configureRpc({ perConnectionConcurrent: 1, globalConcurrent: ${mode === 'queued-only' ? 1 : 10}, timeout: 0 });
				let broken = false;
				_setTenantResolver(() => { if (broken) throw new Error('private/tenant-value'); return 'safe'; });
				const ws = mockWs({ id: 'member', userId: 'member', sessionId: 'session' });
				${opened ? 'api.pushHooks.open(ws, { platform });' : ''}
				let release, signal, started, runs = 0;
				const gate = new Promise(resolve => { release = resolve; });
				const ready = new Promise(resolve => { started = resolve; });
				const hold = async ctx => { runs++; signal = ctx.abortSignal; started(); await gate; return 'finished'; };
				api.__register('tenant/hold', api.live(hold));
				api.__register('tenant/binary', api.live.binary(hold));
				const binary = id => {
					const header = new TextEncoder().encode(JSON.stringify({ rpc: 'tenant/binary', id }));
					const bytes = new Uint8Array(3 + header.length);
					new DataView(bytes.buffer).setUint16(1, header.length); bytes.set(header, 3); return bytes.buffer;
				};
				const holder = ${mode === 'queued-only' ? "mockWs({ id: 'other' })" : 'ws'};
				api.handleRpc(holder, ${mode === 'binary' ? "binary('running')" : "toArrayBuffer({ rpc: 'tenant/hold', id: 'running' })"}, platform);
				await ready;
				api.handleRpc(ws, ${mode === 'binary' ? "binary('queued')" : "toArrayBuffer({ rpc: 'tenant/hold', id: 'queued' })"}, platform);
				for (let i = 0; i < 5; i++) await flush();
				assert.deepEqual([_rpcAdmissionSnapshot().active, _rpcAdmissionSnapshot().queued, _rpcAdmissionSnapshot().openSignals], [1, 1, 1]);
				broken = true;
				ws.getUserData = () => { throw new Error('Socket closed'); };
				ws.getTopics = () => { throw new Error('Socket closed'); };
				api.close(ws, { platform });
				for (let i = 0; i < 5; i++) await flush();
				assert.equal(signal.aborted, ${mode !== 'queued-only'});
				${mode === 'queued-only' ? '' : "assert.equal(signal.reason.code, 'CONNECTION_CLOSED');"}
				assert.equal(runs, 1);
				assert.equal(_rpcAdmissionSnapshot().queued, 0);
				assert.equal(_rpcAdmissionSnapshot().active, 1);
				assert.equal(_rpcAdmissionSnapshot().openSignals, ${mode === 'queued-only' ? 1 : 0});
				assert.equal(platform.sent.find(row => row.event === 'queued')?.data.code, 'CONNECTION_CLOSED');
				const { _pushRegistry, _pushSessionRegistry } = await import(new URL('./server/push.js', ${JSON.stringify(serverUrl)}));
				assert.equal(_pushRegistry.size, 0); assert.equal(_pushSessionRegistry.size, 0);
				release();
				for (let i = 0; i < 5; i++) await flush();
				assert.deepEqual([_rpcAdmissionSnapshot().active, _rpcAdmissionSnapshot().queued, _rpcAdmissionSnapshot().openSignals], [0, 0, 0]);
				assert.equal(runs, 1);
				api.close(ws, { platform });
				assert.equal(_rpcAdmissionSnapshot().active, 0);
			`));
		});
	}

	it.each([false, true])('closes the original socket after another open reuses its user data (accessor throws=%s)', throws => {
		succeeded(run(`
			api.configureRpc({ perConnectionConcurrent: 2, timeout: 0 });
			const shared = { id: 'member' };
			const first = mockWs(shared), second = { ...mockWs({}), getUserData: () => shared };
			const signals = new Map(), releases = new Map();
			api.__register('tenant/hold', api.live(async (ctx, label) => {
				signals.set(label, ctx.abortSignal);
				await new Promise(resolve => releases.set(label, resolve));
				return label;
			}));
			api.__register('tenant/healthy', api.live(() => 'healthy'));
			api.pushHooks.open(first, { platform });
			api.handleRpc(first, toArrayBuffer({ rpc: 'tenant/hold', id: 'first', args: ['first'] }), platform);
			for (let i = 0; i < 5; i++) await flush();
			assert.equal(signals.get('first').aborted, false);
			api.pushHooks.open(second, { platform });
			api.handleRpc(second, toArrayBuffer({ rpc: 'tenant/hold', id: 'second', args: ['second'] }), platform);
			for (let i = 0; i < 5; i++) await flush();
			assert.equal(signals.get('second').aborted, false);
			${throws ? "first.getUserData = () => { throw new Error('Socket closed'); }; first.getTopics = () => { throw new Error('Socket closed'); };" : ''}
			api.close(first, { platform });
			assert.equal(signals.get('first').aborted, true);
			assert.equal(signals.get('second').aborted, false);
			assert.equal(_rpcAdmissionSnapshot().active, 2);
			// A late dispatch can still hold the shared user object after its
			// original socket closed and another open replaced the user's slot.
			first.getUserData = () => shared;
			api.handleRpc(first, toArrayBuffer({ rpc: 'tenant/healthy', id: 'late-first' }), platform);
			for (let i = 0; i < 5; i++) await flush();
			assert.equal(platform.sent.find(row => row.event === 'late-first')?.data.code, 'CONNECTION_CLOSED');
			assert.equal(signals.get('second').aborted, false);
			releases.get('first')();
			for (let i = 0; i < 5; i++) await flush();
			assert.equal(_rpcAdmissionSnapshot().active, 1);
			api.close(first, { platform });
			assert.equal(signals.get('second').aborted, false);
			api.handleRpc(second, toArrayBuffer({ rpc: 'tenant/healthy', id: 'healthy' }), platform);
			for (let i = 0; i < 5; i++) await flush();
			assert.equal(platform.sent.find(row => row.event === 'healthy')?.data.data, 'healthy');
			api.close(second, { platform });
			assert.equal(signals.get('second').aborted, true);
			releases.get('second')();
			for (let i = 0; i < 5; i++) await flush();
			assert.deepEqual([_rpcAdmissionSnapshot().active, _rpcAdmissionSnapshot().queued, _rpcAdmissionSnapshot().openSignals], [0, 0, 0]);
		`));
	});

	it('keeps a freshly opened connection generation independent while an aborted old handler settles', () => {
		succeeded(run(`
			api.configureRpc({ timeout: 0 });
			const ws = mockWs({ id: 'member' });
			const signals = new Map(), releases = new Map();
			api.__register('tenant/generation', api.live(async (ctx, label) => {
				signals.set(label, ctx.abortSignal);
				await new Promise(resolve => releases.set(label, resolve));
				return label;
			}));
			api.pushHooks.open(ws, { platform });
			api.handleRpc(ws, toArrayBuffer({ rpc: 'tenant/generation', id: 'old', args: ['old'] }), platform);
			for (let i = 0; i < 5; i++) await flush();
			api.close(ws, { platform });
			assert.equal(signals.get('old').aborted, true);
			api.pushHooks.open(ws, { platform });
			api.handleRpc(ws, toArrayBuffer({ rpc: 'tenant/generation', id: 'new', args: ['new'] }), platform);
			for (let i = 0; i < 5; i++) await flush();
			assert.equal(signals.get('new').aborted, false);
			assert.equal(_rpcAdmissionSnapshot().active, 2);
			releases.get('old')();
			for (let i = 0; i < 5; i++) await flush();
			assert.equal(signals.get('new').aborted, false);
			assert.equal(_rpcAdmissionSnapshot().active, 1);
			ws.getUserData = () => { throw new Error('Socket closed'); };
			api.close(ws, { platform });
			assert.equal(signals.get('new').aborted, true);
			releases.get('new')();
			for (let i = 0; i < 5; i++) await flush();
			assert.deepEqual([_rpcAdmissionSnapshot().active, _rpcAdmissionSnapshot().queued, _rpcAdmissionSnapshot().openSignals], [0, 0, 0]);
		`));
	});

	it.each(['throw', 'invalid'])('drains active uploads, smooth entities and native document references on %s', failure => {
		succeeded(run(`
			let broken = false;
			_setTenantResolver(() => { if (!broken) return 'original'; ${failure === 'throw' ? "throw new Error('private/tenant-value');" : "return 'private/tenant-value';"} });
			const ws = mockWs({ id: 'member', userId: 'member', sessionId: 'session' });
			const smooth = await import('svelte-adapter-uws/plugins/smooth');
			const replica = await import('svelte-adapter-uws/plugins/crdt/replica');
			const codec = await import('svelte-adapter-uws/plugins/crdt');
			let authority;
			api._setSmoothRuntime(smooth);
			api._setCrdtRuntime({ ...replica, ...codec, createCrdtAuthority(options) { return authority = replica.createCrdtAuthority(options); } });
			const shape = api.live.smooth({ topic: 'entities', initial: { x: 0 }, apply: value => value });
			const doc = api.live.doc({ topic: 'document', guard: () => true });
			api.__register('tenant/smooth', shape.__smoothSync);
			api.__register('tenant/document', doc.__docSync);
			for (const [id, rpc] of [['smooth', 'tenant/smooth'], ['document', 'tenant/document']]) {
				api.handleRpc(ws, toArrayBuffer({ rpc, id, args: [] }), platform);
				for (let i = 0; i < 20 && !platform.sent.some(row => row.event === id); i++) await flush();
				assert.equal(platform.sent.find(row => row.event === id)?.data.ok, true);
			}
			const { _smoothTopics } = await import(new URL('./server/smooth.js', ${JSON.stringify(serverUrl)}));
			assert.equal(_smoothTopics.get('@t/original/entities').authority.size, 1);
			assert.equal(authority.has('@t/original/document'), true);
			let signal, stopped = false, started;
			const ready = new Promise(resolve => { started = resolve; });
			api.__register('tenant/upload', api.live.upload(async ctx => {
				signal = ctx.abortSignal; started();
				try { for await (const chunk of ctx.stream) {} } catch {} finally { stopped = true; }
			}));
			const header = new TextEncoder().encode(JSON.stringify({ rpc: 'tenant/upload', args: [] }));
			const upload = new Uint8Array(12 + header.length);
			upload[0] = 1; upload[1] = 1;
			new DataView(upload.buffer).setUint32(2, 1); new DataView(upload.buffer).setUint16(10, header.length); upload.set(header, 12);
			api.handleRpc(ws, upload.buffer, platform); await ready;
			assert.equal(signal.aborted, false); assert.equal(stopped, false);
			api.pushHooks.open(ws, { platform });
			api.__register('tenant/manual', api.live.stream('manual', () => [], { onUnsubscribe() { assert.fail('no admitted tenant'); } }));
			ws.subscribe('manual');
			broken = true;
			api.close(ws, { platform });
			for (let i = 0; i < 10; i++) await flush();
			assert.equal(signal.aborted, true); assert.equal(stopped, true);
			assert.equal(_smoothTopics.has('@t/original/entities'), false);
			assert.equal(authority.has('@t/original/document'), false);
			const { _pushRegistry, _pushSessionRegistry } = await import(new URL('./server/push.js', ${JSON.stringify(serverUrl)}));
			assert.equal(_pushRegistry.size, 0); assert.equal(_pushSessionRegistry.size, 0);
			assert.equal(_rpcAdmissionSnapshot().active, 0);
			assert.equal(platform.published.some(row => row.topic.includes('@t/other/') || row.topic === 'manual'), false);
			api._resetSmooth(); api._resetCrdt();
		`));
	});
	for (const action of ['close', 'unsubscribe']) {
		for (const failure of ['throw', 'invalid', 'changed', 'user-throws']) {
			it(`uses admitted stream ownership on ${action} when the resolver is ${failure}`, () => {
				succeeded(run(`
					let broken = false;
					_setTenantResolver(() => { if (!broken) return 'original'; ${failure === 'throw' ? "throw new Error('private/tenant-value');" : failure === 'invalid' ? "return 'private/tenant-value';" : "return 'other';"} });
					const ws = mockWs({ id: 'member', userId: 'member', sessionId: 'session' });
					const seen = [];
					api.__register('tenant/stream', api.live.stream('updates', () => [], { onUnsubscribe(ctx, topic) {
						seen.push({ tenantId: ctx.tenantId, topic });
						ctx._publishWire('@t/' + ctx.tenantId + '/departures', 'left', {});
						ctx.publish('app-departures', 'left', {});
					} }));
					api.handleRpc(ws, toArrayBuffer({ rpc: 'tenant/stream', id: 'sub', stream: true }), platform);
					for (let i = 0; i < 5; i++) await flush();
					assert.equal(platform.sent.at(-1).data.ok, true);
					api.pushHooks.open(ws, { platform });
					broken = true;
					${failure === 'user-throws' ? "ws.getUserData = () => { throw new Error('Socket closed'); }; ws.getTopics = () => { throw new Error('Socket closed'); };" : ''}
					${action === 'close' ? 'api.close(ws, { platform });' : "api.unsubscribe(ws, '@t/original/updates', { platform });"}
					for (let i = 0; i < 5; i++) await flush();
					assert.deepEqual(seen, [{ tenantId: 'original', topic: '@t/original/updates' }]);
					assert.deepEqual(platform.published.map(row => row.topic), ['@t/original/departures', '@t/original/app-departures']);
					${action === 'close' ? `const { _pushRegistry, _pushSessionRegistry } = await import(new URL('./server/push.js', ${JSON.stringify(serverUrl)}));
					assert.equal(_pushRegistry.size, 0); assert.equal(_pushSessionRegistry.size, 0);` : ''}
				`));
			});
		}
	}

	it.each(['throw', 'invalid'])('drains push ownership without inventing a tenant for untracked hooks (%s)', failure => {
		succeeded(run(`
			let broken = false;
			_setTenantResolver(() => { if (!broken) return 'original'; ${failure === 'throw' ? "throw new Error('private/tenant-value');" : "return 'private/tenant-value';"} });
			const ws = mockWs({ id: 'member', userId: 'member', sessionId: 'session' });
			let invoked = 0;
			api.__register('tenant/manual', api.live.stream('manual', () => [], { onUnsubscribe(ctx) { invoked++; ctx.publish('leak', 'left', {}); } }));
			ws.subscribe('manual'); api.pushHooks.open(ws, { platform });
			broken = true;
			api.close(ws, { platform });
			for (let i = 0; i < 5; i++) await flush();
			const { _pushRegistry, _pushSessionRegistry } = await import(new URL('./server/push.js', ${JSON.stringify(serverUrl)}));
			assert.equal(_pushRegistry.size, 0); assert.equal(_pushSessionRegistry.size, 0);
			assert.equal(invoked, 0); assert.equal(platform.published.length, 0);
			assert.equal(JSON.stringify(diagnostics).includes('private/tenant-value'), false);
			assert.equal(diagnostics.some(record => record.event === 'close.tenant.failed'), true);
		`));
	});
});
