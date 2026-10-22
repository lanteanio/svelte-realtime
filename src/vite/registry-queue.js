// @ts-check
/** Serialize registry evaluation without letting a hung import hide its failure. */
export function _createRegistryQueue() {
	/** @type {Promise<unknown>} */
	let previous = Promise.resolve();
	/** @type {Promise<unknown> | null} */
	let blocked = null;
	/** @template T @param {() => Promise<T>} run */
	return (run) => {
		if (blocked) return Promise.reject(new Error('[svelte-realtime] Registry queue is waiting for a timed-out import to settle. Fix the import or restart the dev server.'));
		let started = false;
		let cancelled = false;
		const timeoutError = new Error('[svelte-realtime] Registry work timed out after 30000ms; queue waits for the outstanding import to settle. Fix the import or restart the dev server.');
		const work = previous.then(() => {
			if (cancelled) throw timeoutError;
			started = true;
			return run();
		});
		// The internal queue follows actual evaluation, never the caller timeout.
		// Module evaluation cannot be cancelled: a late import must finish before
		// a newer registry can start. Queued writes may time out before they begin.
		previous = work.catch(() => {});
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => { // determinism-allow: bounds Vite development work, outside the realtime runtime
				if (started) blocked = work;
				else cancelled = true;
				reject(timeoutError);
			}, 30000);
			const settled = () => {
				clearTimeout(timer); // determinism-allow: pairs the Vite development deadline above
				if (blocked === work) blocked = null;
			};
			work.then(value => { settled(); resolve(value); }, error => { settled(); reject(error); });
		});
	};
}
