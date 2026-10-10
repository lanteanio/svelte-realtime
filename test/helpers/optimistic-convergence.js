import { vi } from 'vitest';
import { createSeededRng, FIXED_EPOCH } from 'svelte-adapter-uws/sim';

const wire = vi.hoisted(() => ({ adapter: null }));
vi.mock('svelte-adapter-uws/client', () => ({
	connect: (...args) => wire.adapter.connect(...args),
	on: (...args) => wire.adapter.on(...args),
	status: { subscribe: (...args) => wire.adapter.status.subscribe(...args) },
	failure: { subscribe: (...args) => wire.adapter.failure.subscribe(...args) },
	denials: { subscribe: (...args) => wire.adapter.denials.subscribe(...args) },
	onRequest: (...args) => wire.adapter.onRequest(...args),
	onDerived: (...args) => wire.adapter.onDerived(...args),
	setTopicManaged: (...args) => wire.adapter.setTopicManaged(...args)
}));

const copy = value => JSON.parse(JSON.stringify(value));
const ticks = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const canonical = rows => [...rows].sort((a, b) => a.id.localeCompare(b.id));
function deferred() {
	let resolve, reject;
	const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
	return { promise, resolve, reject };
}
function shuffle(values, rng) {
	const result = [...values];
	for (let i = result.length - 1; i > 0; i--) { const j = rng.int(i + 1); [result[i], result[j]] = [result[j], result[i]]; }
	return result;
}

export async function createReplicaNetwork(seed) {
	vi.resetModules();
	vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
	vi.setSystemTime(FIXED_EPOCH);
	const topics = new Map(), statuses = new Set(), sent = [], replicas = [];
	let status = 'open';
	const adapter = {
		setTopicManaged() {},
		on(topic) { return { subscribe(fn) {
			let listeners = topics.get(topic);
			if (!listeners) topics.set(topic, listeners = new Set());
			listeners.add(fn);
			return () => { listeners.delete(fn); if (!listeners.size) topics.delete(topic); };
		} }; },
		status: { subscribe(fn) { statuses.add(fn); fn(status); return () => statuses.delete(fn); } },
		failure: { subscribe(fn) { fn(null); return () => {}; } },
		denials: { subscribe(fn) { fn(null); return () => {}; } },
		onRequest: () => () => {},
		onDerived: () => ({ subscribe: () => () => {} })
	};
	const connection = { ...adapter, send: frame => sent.push(frame), sendQueued: frame => sent.push(frame), bufferedAmount: 0 };
	adapter.connect = () => connection;
	wire.adapter = adapter;
	const { __stream } = await import('../../src/client.js');
	const runtime = await import('../../src/client-runtime.js');
	runtime.setRuntimeEnv({ rng: createSeededRng(seed + ':runtime') }, { force: true });
	const { clientState } = await import('../../src/client/internal-state.js');
	clientState.config.resumeGraceMs = 0;
	const emit = (topic, envelope) => { for (const fn of [...(topics.get(topic) || [])]) fn(copy(envelope)); };
	return {
		async replica(index) {
			const path = 'fuzz/items' + index, topic = 'fuzz:items:' + index;
			const store = __stream(path, { merge: 'crud', key: 'id' });
			let value;
			const off = store.subscribe(next => { value = next; });
			await ticks();
			const client = { index, store, off, topic, value: () => value,
				emit(event) { emit(topic, event); },
				request() { const frames = sent.splice(0).flatMap(frame => frame.batch || [frame]); const found = frames.find(frame => frame.rpc === path && frame.stream); sent.push(...frames.filter(frame => frame !== found)); return found; },
				attach(id) { emit('__rpc', { event: id, data: { attach: true, topic } }); },
				answer(id, data) { emit('__rpc', { event: id, data: { ok: true, topic, merge: 'crud', key: 'id', ...data } }); }
			};
			replicas.push(client);
			return client;
		},
		async reconnect() {
			for (const next of ['disconnected', 'connecting', 'open']) { status = next; for (const fn of [...statuses]) fn(next); }
			await vi.advanceTimersByTimeAsync(100); await ticks();
		},
		async close() {
			for (const client of replicas) client.off();
			await ticks(); vi.setSystemTime(Date.now() + 2000);
			status = 'failed'; for (const fn of [...statuses]) fn(status);
			await ticks(); runtime.resetRuntimeEnv(); vi.useRealTimers();
		}
	};
}

/** Seeded contract exploration over independent stream replicas on a controlled wire. */
export async function runOptimisticConvergence(seed, { omitRecovery = false } = {}) {
	const rng = createSeededRng(seed);
	const initial = new Map(), server = new Map(), history = [];
	const plan = [], trace = [];
	let sequence = 0;
	const count = 2 + rng.int(3);
	for (let client = 0; client < count; client++) {
		const operations = [];
		for (let index = 0, n = 2 + rng.int(4); index < n; index++) {
			const id = 'client-' + client + '-row-' + index;
			const event = ['created', 'updated', 'deleted'][rng.int(3)];
			const data = { id, value: 1 + rng.int(1000) };
			if (event !== 'created') initial.set(id, { id, value: 0 });
			operations.push({ client, event, data, accepted: rng.int(3) !== 0, functional: rng.int(2) === 0 });
		}
		plan.push(operations);
	}
	for (const [key, row] of initial) server.set(key, copy(row));
	const apply = operation => {
		if (operation.event === 'deleted') server.delete(operation.data.id);
		else server.set(operation.data.id, copy(operation.data));
		history.push({ event: operation.event, data: copy(operation.data), seq: ++sequence });
	};
	const actual = [], clients = [], pending = [];
	const net = await createReplicaNetwork(seed);
	// Each replica has its own stream baseline, cursor and optimistic queue.
	// They share a controlled transport; delivery order is independent per topic.
	for (const operation of shuffle(plan.flat(), rng)) if (operation.accepted) apply(operation);
	for (let index = 0; index < 3; index++) apply({ event: 'created', data: { id: 'server-before-' + index, value: rng.int(1000) } });
	const snapshot = copy([...server.values()]);
	const committed = copy(history);
	const late = [];
	for (let index = 0, n = 1 + rng.int(4); index < n; index++) {
		apply({ event: 'created', data: { id: 'server-buffered-' + index, value: rng.int(1000) } });
		late.push(history.at(-1));
	}
	try {
		for (let index = 0; index < count; index++) {
			const client = await net.replica(index);
			clients.push(client);
			const firstRequest = client.request();
			if (!firstRequest) throw new Error('Missing initial subscribe');
			client.answer(firstRequest.id, { data: [...initial.values()], seq: 0 });
			const ownPending = [];
			for (const operation of plan[index]) {
				const gate = deferred();
				const change = operation.functional ? rows => {
					const next = rows.filter(row => row.id !== operation.data.id);
					return operation.event === 'deleted' ? next : [...next, operation.data];
				} : { event: operation.event, data: operation.data };
				const done = client.store.mutate(() => gate.promise, change).then(() => true, () => false);
				const entry = { operation, gate, done };
				ownPending.push(entry); pending.push(entry);
			}
			client.pending = ownPending;
		}
		const settle = async (entry, phase) => {
			entry.settled = true;
			trace.push({ settled: entry.operation.data.id, accepted: entry.operation.accepted, phase });
			if (entry.operation.accepted) entry.gate.resolve('committed');
			else entry.gate.reject(new Error('server refused mutation'));
			if (await entry.done !== entry.operation.accepted) throw new Error('Mutation settlement disagrees with server decision');
		};
		// Keep at least one overlay until recovery; vary the remaining acknowledgements.
		for (const client of clients) {
			for (const entry of shuffle(client.pending.slice(1), rng)) {
				if (rng.int(3) === 0) await settle(entry, 'before-reconnect');
			}
		}
		const schedules = clients.map((client, index) => {
				const mode = index === 0 ? 'full' : ['full', 'delta', 'replay', 'unchanged'][rng.int(4)];
				const delivered = mode === 'unchanged' ? committed.length : index === 0 ? 0 : rng.int(committed.length + 1);
				for (const event of committed.slice(0, delivered)) client.emit(event);
				return { client, index, mode, delivered };
		});
		await net.reconnect();
		for (const { client, index, mode, delivered } of shuffle(schedules, rng)) {
				const request = client.request();
				if (!request) throw new Error('Reconnect did not send a subscribe');
				client.attach(request.id);
				let data = snapshot;
				if (mode === 'delta') data = [...snapshot, ...[...initial.keys()].filter(key => !server.has(key)).map(id => ({ id, _deleted: true }))];
				if (mode === 'replay') data = committed.slice(delivered);
				const split = rng.int(late.length + 1);
				for (const event of late.slice(0, split)) client.emit(event);
				for (const entry of shuffle(client.pending.slice(1).filter(entry => !entry.settled), rng)) {
					if (rng.int(2) === 0) await settle(entry, 'before-snapshot');
				}
				if (!(omitRecovery && index === 0)) client.answer(request.id, { data: mode === 'unchanged' ? undefined : data, ...(mode === 'full' ? {} : { [mode]: true }), seq: committed.length });
				for (const event of late.slice(split)) client.emit(event);
				trace.push({ client: index, mode, delivered, buffered: split });
				if (!(omitRecovery && index === 0) && !client.value().some(row => row.id === 'server-before-0')) throw new Error('Recovered snapshot lost server-owned rows under pending overlays');
				for (const entry of shuffle(client.pending.filter(entry => !entry.settled), rng)) await settle(entry, 'after-snapshot');
				actual[client.index] = canonical(client.value());
		}
		const expected = canonical([...server.values()]);
		for (let index = 0; index < actual.length; index++) {
			if (JSON.stringify(actual[index]) !== JSON.stringify(expected)) throw new Error('Replica ' + index + ' differs from server authority: ' + JSON.stringify({ expected, actual: actual[index] }));
		}
		return { seed, plan, trace, expected, actual };
	} catch (error) {
		throw new Error('Optimistic convergence failed; reproduce with REALTIME_CLIENT_SEED=' + seed + '\n' + error.message + '\n' + JSON.stringify({ seed, plan, trace }), { cause: error });
	} finally {
		for (const entry of pending) { entry.gate.reject(new Error('test cleanup')); await entry.done; }
		await net.close();
	}
}
