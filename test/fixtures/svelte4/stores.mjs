import assert from 'node:assert/strict';
import { get } from 'svelte/store';
import { __stream, configure } from 'svelte-realtime/client';
import { connect } from 'svelte-adapter-uws/client';

configure({ resumeGraceMs: 0 });

const stream = __stream('fixture/rows', { merge: 'crud' });
stream.hydrate([{ id: 1, value: 4 }]);
assert.deepEqual(get(stream), [{ id: 1, value: 4 }]);
const doubled = stream.map((row) => row.value * 2);
assert.deepEqual(get(doubled), [8]);
stream.hydrate([{ id: 1, value: 7 }]);
assert.deepEqual(get(stream), [{ id: 1, value: 7 }]);
assert.deepEqual(get(doubled), [14]);
assert.equal(stream.rune(), stream);
assert.deepEqual(stream.current, [{ id: 1, value: 7 }]);
assert.deepEqual(doubled.current, [14]);
await Promise.resolve();
connect().close();
console.log('Svelte 4 store subscribe, hydrate, map and current passed');
