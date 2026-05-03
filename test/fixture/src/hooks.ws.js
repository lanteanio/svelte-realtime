export { message } from 'svelte-realtime/server';

// Read user identity from cookies. Multi-page-auth e2e tests set
// `user` and `role` cookies via `context.addCookies(...)` BEFORE
// page.goto, so the WS upgrade includes them. Defaults keep the
// queue-replay / lock / smoke / reconnect / multi-page tests working
// unchanged (they don't set cookies).
export function upgrade({ cookies }) {
	const id = (cookies && cookies.user) || 'e2e-user';
	const role = (cookies && cookies.role) || 'user';
	return { id, role };
}
