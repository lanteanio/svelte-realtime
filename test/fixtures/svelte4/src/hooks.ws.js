export { message, close, unsubscribe } from 'svelte-realtime/server';

export function upgrade() {
	return { id: crypto.randomUUID() };
}
