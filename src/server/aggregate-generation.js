// @ts-check
import { aggregateRegistry, _aggregateByTopic } from './state.js';
import { LiveError } from './live-error.js';

const MAX_SEQUENCE = (1n << 128n) - 1n;
/** @type {any} */
let configured = null;
/** @type {any} */
let original = null;

/** Invalidate pending hydrations and wake their loaders. @param {any} entry */
export function _invalidateAggregateGeneration(entry) {
	entry._generation++;
	_invalidateAggregatePublication(entry);
}

/** Invalidate contribution callbacks without discarding retained snapshot hydration. @param {any} entry */
export function _invalidateAggregatePublication(entry) {
	entry._generationChanged?.resolve();
	/** @type {any} */
	let resolve;
	const promise = new Promise(done => { resolve = done; });
	entry._generationChanged = { promise, resolve };
}

/** @param {any} value */
export function _configureAggregateGeneration(value) {
	if (value === original) return;
	if ([...aggregateRegistry.values()].some(entry => entry._aggregateUsed)) throw new Error('Configure aggregateGenerationStore before using registered aggregates');
	if (value === null) { configured = null; original = null; }
	else {
		if (!value || typeof value.namespace !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value.namespace) ||
			['issueErasure', 'readGeneration', 'advanceGeneration'].some(name => typeof value[name] !== 'function')) {
			throw new Error('aggregateGenerationStore requires a namespace, issueErasure, readGeneration and advanceGeneration');
		}
		configured = Object.freeze({ namespace: value.namespace,
			readGeneration: value.readGeneration.bind(value), advanceGeneration: value.advanceGeneration.bind(value) });
		original = value;
	}
	for (const entry of aggregateRegistry.values()) {
		_invalidateAggregateGeneration(entry);
		entry._hydrationPromise = null;
		_bootstrapAggregateGeneration(entry);
		entry._startHydration?.();
	}
}

/** @param {any} value @param {string} namespace @param {boolean} [positive] */
function token(value, namespace, positive = false) {
	const sequence = value?.sequence;
	if (!value || value.namespace !== namespace || typeof sequence !== 'string' ||
		!/^(0|[1-9][0-9]{0,38})$/.test(sequence) || BigInt(sequence) > MAX_SEQUENCE ||
		(positive && sequence === '0')) throw new Error('Invalid aggregate generation');
	return Object.freeze({ namespace, sequence });
}

/** @param {any} value */
export function _readAggregateErasure(value) {
	if (!configured && value === undefined) return undefined;
	try {
		if (!configured) throw new Error();
		return token(value, configured.namespace, true);
	} catch {
		throw new LiveError('INVALID_REQUEST', 'live.forget: aggregateErasure must be a positive token issued by the configured aggregateGenerationStore');
	}
}

/** @param {any} entry */
function current(entry) { return _aggregateByTopic.get(entry.baseTopic || entry.topic) === entry; }
/** @param {any} entry @param {any} generation @param {boolean} [persisted] */
function assign(entry, generation, persisted = true) {
	const suffix = persisted ? '\0store\0' + generation.namespace + '\0' + generation.sequence : '\0local\0' + generation.sequence;
	entry._noiseGeneration = suffix;
	if (entry.windowStates) for (const holder of entry.windowStates.values()) holder._noiseGeneration = suffix;
}

/** Start the durable read before snapshots or publications can run. @param {any} entry */
export function _bootstrapAggregateGeneration(entry) {
	if (!entry._generationChanged) _invalidateAggregateGeneration(entry);
	entry._aggregateBlocked = false;
	entry._persistedGeneration = null;
	entry._noiseGeneration = '';
	if (entry.windowStates) for (const holder of entry.windowStates.values()) holder._noiseGeneration = '';
	if (!configured || entry.forget !== 'reset') return;
	entry._aggregateBlocked = true;
	const store = configured;
	const epoch = entry._generation;
	/** @type {any} */
	const generation = entry._persistedGeneration = { store, value: null, target: null, work: null, inflight: null, bootstrap: null, error: null };
	generation.bootstrap = Promise.resolve().then(() => store.readGeneration(entry.baseTopic || entry.topic)).then(value => {
		const restored = token(value, store.namespace);
		if (!current(entry) || entry._generation !== epoch) return;
		generation.value = restored;
		assign(entry, restored);
		entry._aggregateBlocked = false;
	}).catch(() => {
		const error = new Error('Aggregate generation bootstrap failed');
		if (current(entry) && entry._generation === epoch) generation.error = error;
		throw error;
	});
	// A registration has no awaiting caller; its loader observes this failure.
	generation.bootstrap.catch(() => {});
}

/** @param {any} entry */
export async function _awaitAggregateGeneration(entry) {
	entry._aggregateUsed = true;
	for (;;) {
		const epoch = entry._generation;
		const boundary = entry._generationChanged;
		const changed = boundary.promise;
		const generation = entry._persistedGeneration;
		if (generation?.work) await Promise.race([generation.work, changed]);
		else if (entry._aggregateBlocked) {
			if (generation?.error) throw generation.error;
			if (generation?.bootstrap) await Promise.race([generation.bootstrap, changed]);
			else throw new Error('Aggregate reset is incomplete');
			if (epoch === entry._generation && entry._aggregateBlocked && !generation?.work) throw new Error('Aggregate reset is incomplete');
		}
		if (epoch !== entry._generation || boundary !== entry._generationChanged) continue;
		if (entry._hydrationPromise) await Promise.race([entry._hydrationPromise, changed]);
		if (!current(entry)) throw new Error('Aggregate registration changed');
		if (epoch === entry._generation && boundary === entry._generationChanged && !entry._aggregateBlocked) return;
	}
}

/**
 * At most one store call and one highest requested token per aggregate. Older
 * tokens join the same operation; completed older tokens cannot reset new input.
 * @param {any} entry @param {any} next
 * @param {() => void} discard @param {() => number} reset
 * @param {(value: any) => any} wait
 * @returns {Promise<number>}
 */
export function _advanceAggregateGeneration(entry, next, discard, reset, wait) {
	entry._aggregateUsed = true;
	const generation = entry._persistedGeneration;
	if (!generation) throw new Error('Aggregate generation store is unavailable');
	const requested = token(next, generation.store.namespace, true);
	if (!entry._aggregateBlocked && generation.value && BigInt(requested.sequence) <= BigInt(generation.value.sequence)) return Promise.resolve(0);
	if (!generation.target || BigInt(requested.sequence) > BigInt(generation.target.sequence)) {
		generation.target = requested;
		_invalidateAggregateGeneration(entry);
	}
	if (generation.work) return generation.work;
	// A timed-out call still owns its raw promise until it settles. Refuse
	// retries now rather than retaining one more waiter for every timeout.
	if (generation.inflight) return Promise.reject(generation.error || new Error('Aggregate generation reset failed'));
	entry._aggregateBlocked = true;
	_invalidateAggregateGeneration(entry);
	entry._hydrationPromise = null;
	generation.error = null;
	discard();
	const work = Promise.resolve().then(async () => {
		for (;;) {
			let inflight = generation.inflight;
			if (!inflight) {
				const target = generation.target;
				inflight = { target, promise: Promise.resolve().then(() => generation.store.advanceGeneration(entry.baseTopic || entry.topic, target)) };
				generation.inflight = inflight;
				const retained = inflight;
				inflight.promise.finally(() => { if (generation.inflight === retained) generation.inflight = null; }).catch(() => {});
			}
			const value = token(await wait(inflight.promise), generation.store.namespace);
			if (!current(entry)) throw new Error('Aggregate registration changed');
			if (BigInt(value.sequence) < BigInt(inflight.target.sequence) || (generation.value && BigInt(value.sequence) < BigInt(generation.value.sequence))) {
				throw new Error('Aggregate generation moved backwards');
			}
			generation.value = value;
			assign(entry, value);
			if (BigInt(value.sequence) < BigInt(generation.target.sequence)) continue;
			const before = generation.target;
			let count;
			try { count = reset(); }
			catch (error) { if (before !== generation.target) continue; throw error; }
			if (before !== generation.target) continue;
			entry._aggregateBlocked = false;
			return count;
		}
	}).catch(() => {
		generation.error = new Error('Aggregate generation reset failed');
		throw generation.error;
	}).finally(() => { if (generation.work === work) generation.work = null; });
	generation.work = work;
	return work;
}

/** @param {any} entry */
export function _advanceLocalAggregateGeneration(entry) {
	if (entry._persistedGeneration) return;
	const value = BigInt(entry._localNoiseGeneration || '0') + 1n;
	if (value > MAX_SEQUENCE) throw new Error('Aggregate generation exhausted');
	entry._localNoiseGeneration = String(value);
	assign(entry, { sequence: String(value) }, false);
}
