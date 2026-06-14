// @ts-check
import { state } from './state.js';

/**
 * Write the process-wide bus. Validated like `configureCron({ bus })`
 * - must expose `.wrap(platform)` or be `null`. Mirrored into the
 * legacy `state.cronBus` alias so the existing cron tick keeps reading the
 * canonical value without surgery. Bumps `state.busEpoch` so memoized
 * `bus.wrap(...)` caches (per-platform, computed lazily by the
 * reactive wrap and the RPC message hooks) invalidate on swap.
 * @param {{ wrap: (platform: any) => any } | null} bus
 */
export function _setBus(bus) {
	if (bus !== null && (typeof bus !== 'object' || typeof bus.wrap !== 'function')) {
		throw new Error('[svelte-realtime] setBus: bus must expose a .wrap(platform) method or be null');
	}
	state.bus = bus;
	state.cronBus = bus;
	state.busEpoch++;
}

/** Read the process-wide bus (or null when no cluster intent is wired). */
export function _getBus() {
	return state.bus;
}
