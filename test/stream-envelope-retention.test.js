import { expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';

it('does not retain a released topic payload through a cached cold stream', () => {
	const module = new URL('../src/client.js', import.meta.url).href;
	const script = `
import assert from 'node:assert/strict';
import { register } from 'node:module';
const mock = 'data:text/javascript,' + encodeURIComponent('export const connect=()=>globalThis.adapter; export const status=globalThis.adapter.status; export const setTopicManaged=()=>{};');
const loader = 'data:text/javascript,' + encodeURIComponent('export async function resolve(id,context,next){return id === "svelte-adapter-uws/client" ? {url:'+JSON.stringify(mock)+',shortCircuit:true} : next(id,context);}');
register(loader, import.meta.url);
const listeners = new Map();
const emit = (topic, value) => { for (const fn of listeners.get(topic) || []) fn(value); };
const constant = value => ({ subscribe(fn) { fn(value); return () => {}; } });
const send = frame => {
  if (frame.rpc) queueMicrotask(() => emit('__rpc', {event:frame.id,data:{ok:true,data:0,topic:'retention',merge:'set'}}));
  return true;
};
globalThis.adapter = {
  status:constant('open'), failure:constant(null), denials:constant(null),
  on: topic => ({ subscribe(fn) {
    let set=listeners.get(topic); if(!set) listeners.set(topic,set=new Set());
    set.add(fn); return () => { set.delete(fn); if(!set.size) listeners.delete(topic); };
  }}), send, sendQueued:send, onRequest:()=>()=>{}, bufferedAmount:0
};
const { __stream, configure } = await import(${JSON.stringify(module)});
configure({resumeGraceMs:0});
const stream = __stream('memory/data', {merge:'set'});
let current;
const stop = stream.subscribe(value => { current=value; });
for(let i=0;i<4;i++) await new Promise(setImmediate);
assert.equal(current,0, 'the actual stream must finish its initial request');
let envelope={event:'set',data:{privateData:new Array(1024).fill('private')}};
const reference=new WeakRef(envelope);
emit('retention',envelope);
assert.equal(current,envelope.data);
stop(); envelope=null; current=null;
for(let i=0;i<8;i++){await new Promise(setImmediate); global.gc();}
assert.equal(listeners.has('retention'),false);
assert.equal(reference.deref(),undefined,'cached stream retains a released topic envelope');
assert.equal(typeof stream.subscribe,'function');
`;
	expect(() => execFileSync(process.execPath, ['--expose-gc', '--input-type=module', '-e', script], {
		encoding: 'utf8', timeout: 20000, windowsHide: true
	})).not.toThrow();
}, 25000);
