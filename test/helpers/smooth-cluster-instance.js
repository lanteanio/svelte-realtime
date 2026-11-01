// An isolated realtime instance with real WebSockets and the installed smooth
// authority. Only coordinator transport is replaced by an ordered IPC link.
import { createTestServer } from 'svelte-adapter-uws/testing';
import { live, handleRpc, close, __register, _setSmoothRuntime, _resetSmooth } from '../../src/server.js';

const instance = JSON.parse(process.argv[2]);
_setSmoothRuntime(await import(instance.runtimeUrl || 'svelte-adapter-uws/plugins/smooth'));
let handlers;
let owner = instance.instanceId === 'A';
let epoch = '1';
const leaseMs = instance.leaseMs || 10000;
const pending = [];
const relay = (method, args) => { if (process.connected) process.send({ type: 'relay', method, args }); };
process.on('message', async message => {
	if (message.type === 'takeover') {
		owner = true; epoch = message.epoch;
		process.send({ type: 'controlled', id: message.id });
		return;
	}
	if (message.type === 'stall') {
		process.send({ type: 'controlled', id: message.id });
		const until = performance.now() + message.ms;
		while (performance.now() < until) { /* Hold the event loop beyond the lease. */ }
		return;
	}
	if (message.type === 'stop') {
		_resetSmooth();
		await server.close();
		process.disconnect();
		return;
	}
	if (!handlers) pending.push(message);
	else handlers[message.method](...message.args);
});
const server = await createTestServer({ handler: {
	message(ws, ctx) {
		if (!ctx.isBinary && ctx.msg === undefined) handleRpc(ws, ctx.data, server.platform);
	},
	close
} });
server.platform.smooth = {
	ownershipVersion: 1,
	instanceId: instance.instanceId,
	onMessage(next) {
		handlers = next;
		for (const message of pending.splice(0)) handlers[message.method](...message.args);
	},
	async acquireOwner() { return owner ? { epoch, leaseMs } : null; },
	async renewOwner() { return owner ? { epoch, leaseMs } : null; },
	async releaseOwner() { return true; },
	requestSync(...args) { relay('onSync', args); },
	sendSyncReply(topic, corr, _origin, payload, epoch) { relay('onSyncReply', [topic, corr, payload, epoch]); },
	relayBroadcast(topic, event, data, exclude, seq, epoch) { relay('onBroadcast', [topic, event, data, exclude, seq, instance.instanceId, epoch]); },
	relayCommand(...args) { relay('onCommand', args); },
	relayAck(topic, identity, _origin, payload, epoch) { relay('onAck', [topic, identity, payload, epoch]); },
	relayLeave(...args) { relay('onLeave', args); }
};
const injected = new Set();
const shape = live.smooth({
	topic: (_ctx, room) => 'idle:' + room,
	topicArgs: 1,
	tickMs: 10,
	maxCommandsPerTick: instance.maxCommandsPerTick,
	initial: { x: 0, y: 0 },
	apply: (state, cmd) => {
		if (instance.reportApply) process.send({ type: 'applied', instance: instance.instanceId, dx: cmd.dx });
		return { x: state.x + (cmd.dx || 0), y: state.y };
	},
	...(instance.injectAfterCommand && { onTick(world) {
		for (const entry of world.catalog()) {
			if (entry.state.x < 1 || injected.has(entry.key)) continue;
			injected.add(entry.key);
			world.applyTo(entry.key, { dx: 100 });
			world.applyTo(entry.key, { dx: 200 });
		}
	} }),
	...(instance.interest && { interest: { radius: 100, position: state => state } })
});
__register('idle/shape/__smooth/sync', shape.__smoothSync, 'idle');
__register('idle/shape/__smooth/command', shape.__smoothCommand, 'idle');
process.send({ type: 'ready', url: server.wsUrl });
