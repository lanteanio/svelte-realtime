import { live } from 'svelte-realtime/server';
import { state } from '../lib/server/state.js';
import { token } from '../lib/server/environment.js';

export const echo = live((_ctx, value) => ({ value, token, label: 'initial' }));
export const counter = live.stream('compat:counter', () => state.count, { merge: 'set' });
export const increment = live((ctx, amount) => {
	state.count += amount;
	ctx.publish('compat:counter', 'set', state.count);
	return state.count;
});

export const removed = live(() => 'original');
