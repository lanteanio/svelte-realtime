export { message, close, unsubscribe } from 'svelte-realtime/server';
export function upgrade() { return { id: 'compatibility-test' }; }
// Identifies this process to the compatibility runner's startup check. The
// client ignores a frame of an unknown type, and no live module is loaded.
export function open(ws) {
	ws.send(JSON.stringify({ type: 'kit-compat-identity', token: process.env.KIT_COMPAT_SESSION, pid: process.pid }));
}
