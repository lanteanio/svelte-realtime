import { existsSync } from 'node:fs';
import { live } from 'svelte-realtime/server';

export const wait = live.public(async (_ctx, delayMs) => {
	console.log('lifecycle:work-started');
	const release = process.env.REALTIME_LIFECYCLE_TEST === '1' && process.env.REALTIME_LIFECYCLE_RELEASE_FILE;
	if (release) {
		while (!existsSync(release)) await new Promise((resolve) => setTimeout(resolve, 20));
	} else {
		await new Promise((resolve) => setTimeout(resolve, delayMs));
	}
	console.log('lifecycle:work-completed');
	return 'finished';
});
