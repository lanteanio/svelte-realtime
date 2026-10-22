import { vi } from 'vitest';
import fc from 'fast-check';
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

const copy = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const ticks = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

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

// A property-based convergence fuzzer for the client optimistic layer. Two or
// three stream stores subscribe one topic on a controlled socket, each with
// its own optimistic queue, and mutate a small shared key space through real
// RPCs. A model server owns the authoritative value: it receives each write
// request, commits it (publishing the change to the subscribed socket) or
// refuses it, and answers later, possibly after other replicas' commits and
// server-side writes. The socket can bounce at any point: requests in flight
// are lost to their callers while the server may still commit them, and every
// replica resubscribes with a recovery answer (a full snapshot, a delta or a
// replay) taken anywhere between its attach and the answer, so a commit can
// land after the snapshot it is missing from. Once the system is quiet, every
// replica must show the server's value.

/** The merge strategies the fuzzer drives and how each one models the server. */
export const MERGES = {
	crud: {
		options: { merge: 'crud', key: 'id' },
		initial: keys => new Map(keys.map(k => ['k' + k, { id: 'k' + k, v: 'init' }])),
		snapshot: state => [...state.values()],
		canonical: rows => [...(rows || [])].sort((a, b) => a.id.localeCompare(b.id)),
		// A mutation: its optimistic change, and the server write it commits.
		change(op, v) {
			const id = 'k' + op.key, row = { id, v };
			if (op.kind === 'fn') return rows => [...rows.filter(r => r.id !== id), row];
			if (op.kind === 'delete') return { event: 'deleted', data: { id } };
			return { event: op.kind === 'create' ? 'created' : 'updated', data: row };
		},
		write: (op, v) => op.kind === 'delete' ? { key: 'k' + op.key, remove: true } : { key: 'k' + op.key, row: { id: 'k' + op.key, v } },
		apply(state, write) {
			const had = state.has(write.key);
			if (write.remove) {
				if (!had) return null;
				state.delete(write.key);
				return { event: 'deleted', data: { id: write.key } };
			}
			state.set(write.key, write.row);
			return { event: had ? 'updated' : 'created', data: write.row };
		},
		mutation: fc.record({ kind: fc.constantFrom('create', 'update', 'delete', 'fn'), key: fc.nat(2) }),
		serverWrite: fc.record({ kind: fc.constantFrom('upsert', 'delete'), key: fc.nat(2) }),
		recoveries: ['full', 'delta', 'replay']
	},
	set: {
		options: { merge: 'set' },
		initial: () => ({ v: 'init' }),
		snapshot: state => state,
		canonical: value => value,
		change: (op, v) => op.kind === 'fn' ? () => ({ v }) : { event: 'set', data: { v } },
		write: (op, v) => ({ value: { v } }),
		apply(state, write) { return { event: 'set', data: write.value, state: write.value }; },
		mutation: fc.record({ kind: fc.constantFrom('set', 'fn'), key: fc.constant(0) }),
		serverWrite: fc.record({ kind: fc.constant('set'), key: fc.constant(0) }),
		recoveries: ['full', 'replay']
	},
	presence: {
		options: { merge: 'presence' },
		initial: keys => new Map(keys.map(k => ['u' + k, { key: 'u' + k, data: { v: 'init' } }])),
		snapshot: state => [...state.values()],
		canonical: rows => [...(rows || [])].sort((a, b) => a.key.localeCompare(b.key)),
		change(op, v) {
			const key = 'u' + op.key;
			return op.kind === 'leave' ? { event: 'leave', data: { key } } : { event: 'join', data: { key, data: { v } } };
		},
		write: (op, v) => op.kind === 'leave' ? { key: 'u' + op.key, remove: true } : { key: 'u' + op.key, row: { key: 'u' + op.key, data: { v } } },
		apply(state, write) {
			if (write.remove) {
				if (!state.has(write.key)) return null;
				state.delete(write.key);
				return { event: 'leave', data: { key: write.key } };
			}
			state.set(write.key, write.row);
			return { event: 'join', data: write.row };
		},
		mutation: fc.record({ kind: fc.constantFrom('join', 'leave'), key: fc.nat(2) }),
		serverWrite: fc.record({ kind: fc.constantFrom('join', 'leave'), key: fc.nat(2) }),
		recoveries: ['full', 'replay']
	}
};

/** The generated schedule: replicas, the keys that exist at first, and the steps. */
export function scheduleArbitrary(merge) {
	const model = MERGES[merge];
	const step = fc.oneof(
		{ arbitrary: fc.record({ t: fc.constant('mutate'), r: fc.nat(2), op: model.mutation, accept: fc.boolean() }), weight: 4 },
		{ arbitrary: fc.record({ t: fc.constant('receive'), pick: fc.nat(7) }), weight: 3 },
		{ arbitrary: fc.record({ t: fc.constant('reply'), pick: fc.nat(7) }), weight: 3 },
		{ arbitrary: fc.record({ t: fc.constant('server'), op: model.serverWrite }), weight: 2 },
		{ arbitrary: fc.record({ t: fc.constant('bounce') }), weight: 1 },
		{ arbitrary: fc.record({ t: fc.constant('answer'), pick: fc.nat(3), mode: fc.constantFrom(...model.recoveries), at: fc.nat(7) }), weight: 2 }
	);
	return fc.record({
		replicas: fc.integer({ min: 2, max: 3 }),
		initial: fc.subarray([0, 1, 2]),
		steps: fc.array(step, { minLength: 1, maxLength: 30 })
	});
}

/** One socket and client module, shared by every run of a property. */
export async function openFuzzWire() {
	vi.resetModules();
	vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
	vi.setSystemTime(FIXED_EPOCH);
	const topics = new Map(), statuses = new Set(), sent = [];
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
	const client = await import('../../src/client.js');
	const { clientState } = await import('../../src/client/internal-state.js');
	clientState.config.resumeGraceMs = 0;
	const setStatus = next => { status = next; for (const fn of [...statuses]) fn(next); };
	return {
		client,
		emit(topic, envelope) { for (const fn of [...(topics.get(topic) || [])]) fn(copy(envelope)); },
		frames: () => sent.splice(0).flatMap(frame => frame.batch || [frame]),
		async bounce() {
			setStatus('disconnected');
			setStatus('connecting');
			setStatus('open');
			await vi.advanceTimersByTimeAsync(100);
			await ticks();
		},
		async close() {
			await ticks();
			vi.setSystemTime(Date.now() + 2000);
			setStatus('failed');
			await ticks();
			vi.useRealTimers();
		}
	};
}

let runCounter = 0;

/**
 * Run one schedule to quiescence and return each replica's value and the
 * server's, canonicalized. Throws when a replica differs from the server.
 */
export async function runSchedule(net, merge, schedule) {
	const model = MERGES[merge];
	const run = ++runCounter;
	const path = 'fuzz/' + merge + '/' + run, topic = 'fuzz:' + merge + ':' + run, rpcPath = 'fuzz/write/' + run;
	const write = net.client.__rpc(rpcPath);
	let state = model.initial(schedule.initial);
	let seq = 0, epoch = 0, subscribed = false, ordinal = 0;
	// Every committed event in order, and the state after each one.
	const log = [], versions = [{ seq: 0, state: copy(model.snapshot(state)) }];
	const inbox = [], received = [], answers = [], mutations = [], trace = [];
	const publish = envelope => {
		if (!envelope) return;
		if (envelope.state !== undefined) state = envelope.state;
		const event = { event: envelope.event, data: envelope.data, seq: ++seq };
		log.push(event);
		versions.push({ seq, state: copy(model.snapshot(state)) });
		if (subscribed) net.emit(topic, event);
	};
	const route = () => {
		for (const frame of net.frames()) {
			if (frame.rpc === rpcPath) inbox.push({ id: frame.id, op: frame.args[0], epoch });
			else if (frame.rpc === path && frame.stream) {
				// The server subscribes the socket and acknowledges the attach as
				// soon as a subscribe arrives; its answer follows later.
				const request = { id: frame.id, request: frame, attachedAt: seq };
				answers.push(request);
				subscribed = true;
				net.emit('__rpc', { event: frame.id, data: { attach: true, topic } });
			}
		}
	};
	const answer = (request, mode, at) => {
		const from = versions.findIndex(v => v.seq === request.attachedAt);
		const version = versions[from + (at % (versions.length - from))];
		const since = request.request.seq;
		let data = copy(version.state), flags = {};
		if (mode !== 'full' && since !== undefined && since <= version.seq) {
			const events = log.filter(e => e.seq > since && e.seq <= version.seq);
			if (mode === 'replay') { data = copy(events); flags = { replay: true }; }
			else {
				const touched = new Set(events.map(e => e.data.id));
				data = [...touched].map(id => version.state.find(row => row.id === id) || { id, _deleted: true });
				flags = { delta: true };
			}
		} else mode = 'full';
		trace.push({ answer: request.id, mode, seq: version.seq });
		net.emit('__rpc', { event: request.id, data: { ok: true, topic, ...model.options, data, seq: version.seq, ...flags } });
	};

	const replicas = [];
	try {
		for (let r = 0; r < schedule.replicas; r++) {
			const store = net.client.__stream(path, model.options);
			const replica = { store, value: undefined };
			replica.off = store.subscribe(next => { replica.value = next; });
			replicas.push(replica);
		}
		await ticks();
		route();
		for (const request of answers.splice(0)) answer(request, 'full', 0);
		await ticks();

		for (const step of schedule.steps) {
			if (step.t === 'mutate') {
				const replica = replicas[step.r % replicas.length];
				const v = 'm' + ++ordinal;
				const op = { ...step.op, v, accept: step.accept, replica: step.r % replicas.length };
				const mutation = { op, settled: null };
				mutation.done = replica.store.mutate(() => write.fresh(op), model.change(step.op, v))
					.then(() => { mutation.settled = 'ok'; }, error => { mutation.settled = error.code || error.message; });
				mutations.push(mutation);
				trace.push({ mutate: op });
			} else if (step.t === 'receive' && inbox.length > 0) {
				// The server runs one write handler: it commits or refuses.
				const request = inbox.splice(step.pick % inbox.length, 1)[0];
				if (request.op.accept) publish(model.apply(state, model.write(request.op, request.op.v)));
				received.push(request);
				trace.push({ receive: request.op.v, accept: request.op.accept });
			} else if (step.t === 'reply' && received.length > 0) {
				const request = received.splice(step.pick % received.length, 1)[0];
				// A reply reaches only the connection that sent the request.
				if (request.epoch === epoch) {
					net.emit('__rpc', { event: request.id, data: request.op.accept ? { ok: true, data: request.op.v } : { ok: false, code: 'REFUSED', error: 'refused' } });
				}
				trace.push({ reply: request.op.v, delivered: request.epoch === epoch });
			} else if (step.t === 'server') {
				const v = 's' + ++ordinal;
				publish(model.apply(state, model.write(step.op, v)));
				trace.push({ server: step.op, v });
			} else if (step.t === 'bounce') {
				epoch++;
				subscribed = false;
				answers.length = 0;
				await net.bounce();
				route();
				trace.push({ bounce: epoch });
			} else if (step.t === 'answer' && answers.length > 0) {
				answer(answers.splice(step.pick % answers.length, 1)[0], step.mode, step.at);
			}
			await ticks();
			route();
		}

		// Quiesce: every write is handled, every live request answered, every
		// resubscribe answered with the current state. Time passes, so a
		// resubscribe waiting out a reconnect backoff is sent.
		for (let round = 0; round < 6; round++) {
			await vi.advanceTimersByTimeAsync(round === 0 ? 0 : 5000);
			route();
			for (const request of answers.splice(0)) answer(request, 'full', Number.MAX_SAFE_INTEGER);
			for (const request of inbox.splice(0)) {
				if (request.op.accept) publish(model.apply(state, model.write(request.op, request.op.v)));
				received.push(request);
			}
			for (const request of received.splice(0)) {
				if (request.epoch === epoch) net.emit('__rpc', { event: request.id, data: request.op.accept ? { ok: true, data: request.op.v } : { ok: false, code: 'REFUSED', error: 'refused' } });
			}
			await ticks();
		}
		await Promise.all(mutations.map(m => m.done));
		const expected = model.canonical(copy(model.snapshot(state)));
		const actual = replicas.map(replica => model.canonical(copy(replica.value)));
		for (let r = 0; r < actual.length; r++) {
			if (JSON.stringify(actual[r]) !== JSON.stringify(expected)) {
				throw new Error('Replica ' + r + ' differs from the server: ' + JSON.stringify({ expected, actual: actual[r], trace }));
			}
		}
		return { expected, actual, trace, mutations: mutations.map(m => m.settled) };
	} finally {
		for (const replica of replicas) replica.off();
		await ticks();
		route();
		inbox.length = 0;
		answers.length = 0;
	}
}
