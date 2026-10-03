// @ts-check

/**
 * Every member the Vite plugin can generate on a `live.multiplayer()` client
 * namespace (src/vite/codegen-client.js and the __mpFields fallbacks), whatever
 * the export declares. An action with one of these names would shadow a member
 * or be shadowed by it, so the server refuses such an action and the build
 * never emits one.
 */
export const _MULTIPLAYER_NAMESPACE_MEMBERS = new Set([
	'data', 'presence', 'cursors', 'owner', 'status', 'move', 'reportViewport',
	'identify', 'room', 'watch',
	'typing', 'locks', 'selections', 'reactions',
	'setTyping', 'acquireLock', 'releaseLock', 'setSelection', 'react',
	'_setField', '_emitReaction'
]);
