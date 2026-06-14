// @ts-check

// Cross-section mutable server state, kept in one module instance so the modules
// server.js is split into all read and write the same values.
//
// Maps and Sets are exported as live const bindings (mutated in place). The
// reassignable scalars live as properties on this holder object: an ESM import
// binding is read-only at the consumer, but a property of an imported const
// object can be read AND written from any module, so `state.x = v` works across
// the split where a bare `export let` would not.
export const state = {
	/**
	 * Global handler for server-side errors (cron, effects, derived, webhook
	 * delivery, dispatch). Set via onError(); null until configured.
	 * @type {((path: string, error: unknown) => void) | null}
	 */
	serverErrorHandler: null
};
