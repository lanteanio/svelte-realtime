const policy = await import(new URL(
	'./runtime/handler/cluster-sequence-policy.js', import.meta.resolve('svelte-adapter-uws')
).href);

/** Exercise the installed adapter's multi-worker checks at each publish surface. */
export function enforceClusterPublishPolicy(platform) {
	if (typeof platform.publishBatched === 'function') {
		const publishBatched = platform.publishBatched.bind(platform);
		platform.publishBatched = (messages, ...args) => {
			for (const message of messages) policy.assertClusterSequenceAuthority(message.options, { totalWorkers: 2 });
			return publishBatched(messages, ...args);
		};
	}
	for (const [name, index] of [['publish', 3], ['publishWire', 4], ['publishWireBatch', 4]]) {
		if (typeof platform[name] !== 'function') continue;
		const original = platform[name].bind(platform);
		platform[name] = (...args) => {
			const check = name === 'publishWireBatch' ? policy.assertBatchSequenceAuthority : policy.assertClusterSequenceAuthority;
			check(args[index], { totalWorkers: 2 });
			return original(...args);
		};
	}
}
