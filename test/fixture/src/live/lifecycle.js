import { live } from 'svelte-realtime/server';

export const wait = live.public(async (_ctx, delayMs) => {
	console.log('lifecycle:work-started');
	await new Promise((resolve) => setTimeout(resolve, delayMs));
	console.log('lifecycle:work-completed');
	return 'finished';
});
