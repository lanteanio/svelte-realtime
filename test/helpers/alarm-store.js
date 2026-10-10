/** A deterministic store implementing the public ordered-generation contract. */
export function memoryAlarmStore() {
	const rows = new Map();
	const allocated = new Map();
	const committed = new Map();
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
		due(now) { return [...rows.values()].filter(row => row.at <= now); },
		seed(topic, at, meta) { return store.set(topic, at, meta, store.nextGeneration(topic)); }
	};
	return store;
}
