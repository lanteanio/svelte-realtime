import assert from 'node:assert/strict';
import { get } from 'svelte/store';
import { __stream } from 'svelte-realtime/client';

const stream = __stream('fixture/rows', { merge: 'crud' });
stream.hydrate([{ id: 1, value: 4 }]);
assert.deepEqual(get(stream), [{ id: 1, value: 4 }]);
const doubled = stream.map((row) => row.value * 2);
assert.deepEqual(get(doubled), [8]);
stream.hydrate([{ id: 1, value: 7 }]);
assert.deepEqual(get(stream), [{ id: 1, value: 7 }]);
assert.deepEqual(get(doubled), [14]);
assert.throws(() => stream.rune(), /requires Svelte 5/);
console.log('Svelte 4 store subscribe, hydrate, map and rune boundary passed');
