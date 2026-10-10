// realtime-allow-public
import { live } from 'svelte-realtime/server';

let value = 0;
export const increment = live((ctx) => {
	value++;
	ctx.publish('svelte4:counter', 'set', value);
	return value;
});
export const counter = live.stream('svelte4:counter', () => value, { merge: 'set' });
