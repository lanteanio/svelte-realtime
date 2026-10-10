import { wallEpoch } from '../../src/shared/runtime.js';

/** A deterministic store implementing the public ordered-generation contract. */
export function memoryAlarmStore() {
	const rows = new Map();
	const allocated = new Map();
	const committed = new Map();
	const executions = new Map();
	const key = (topic, generation) => JSON.stringify([topic, generation]);
	const store = {
		rows,
		nextGeneration(topic) {
			const generation = (BigInt(allocated.get(topic) || '0') + 1n).toString();
			allocated.set(topic, generation);
			return generation;
		},
		get(topic) { return rows.get(topic) || null; },
		set(topic, at, meta, generation) {
			if (generation !== allocated.get(topic) || BigInt(generation) <= BigInt(committed.get(topic) || '0')) return false;
			committed.set(topic, generation);
			rows.set(topic, { topic, at, meta: meta ?? null, generation });
			return true;
		},
		delete(topic, generation) {
			if (rows.get(topic)?.generation !== generation) return false;
			return rows.delete(topic);
		},
		claim(topic, generation) {
			const row = rows.get(topic);
			if (!row || row.generation !== generation) return null;
			const attempt = (row.attempt || 0) + 1;
			rows.delete(topic);
			executions.set(key(topic, generation), { ...row, attempt, status: 'claimed', claimedAt: wallEpoch(), failedAt: null, errorClass: null });
			return { attempt };
		},
		complete(topic, generation, attempt) {
			const id = key(topic, generation), execution = executions.get(id);
			if (!execution || execution.attempt !== attempt) return false;
			return executions.delete(id);
		},
		fail(topic, generation, attempt, failure) {
			const execution = executions.get(key(topic, generation));
			if (!execution || execution.attempt !== attempt) return false;
			Object.assign(execution, failure, { status: 'failed' });
			return true;
		},
		getExecution(topic, generation) { return executions.get(key(topic, generation)) || null; },
		executions({ limit = 100, after = null } = {}) {
			const compare = (a, b) => a.topic < b.topic ? -1 : a.topic > b.topic ? 1 : a.generation < b.generation ? -1 : a.generation > b.generation ? 1 : 0;
			const retained = [...executions.values()].sort(compare).filter(row => !after || compare(row, after) > 0);
			const items = retained.slice(0, Math.min(1000, Math.max(1, limit)));
			const last = items.at(-1);
			return { items, next: retained.length > items.length ? { topic: last.topic, generation: last.generation } : null };
		},
		requeue(topic, generation, attempt, { at, allowAbandoned = false }) {
			const id = key(topic, generation), execution = executions.get(id);
			if (!execution || execution.attempt !== attempt || (execution.status !== 'failed' && !allowAbandoned)) return false;
			if (rows.has(topic) || allocated.get(topic) !== generation) return false;
			executions.delete(id);
			rows.set(topic, { topic, at, meta: execution.meta, generation, attempt });
			return true;
		},
		due(now) { return [...rows.values()].filter(row => row.at <= now); },
		seed(topic, at, meta) { return store.set(topic, at, meta, store.nextGeneration(topic)); }
	};
	return store;
}
