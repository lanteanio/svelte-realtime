export { message } from 'svelte-realtime/server';

export function upgrade() {
	return { id: 'e2e-user' };
}
