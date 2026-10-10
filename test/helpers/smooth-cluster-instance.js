// An isolated realtime instance with real WebSockets and the installed smooth
// authority. Only coordinator transport is replaced by an ordered IPC link.
import { createTestServer } from 'svelte-adapter-uws/testing';
import { createSmoothAuthority, createSmoothWireCodec, SMOOTH_TOPIC_PREFIX } from 'svelte-adapter-uws/plugins/smooth';
import { live, handleRpc, close, __register, _setSmoothRuntime, _resetSmooth } from '../../src/server.js';

_setSmoothRuntime({ createSmoothAuthority, createSmoothWireCodec, SMOOTH_TOPIC_PREFIX });
const instance = JSON.parse(process.argv[2]);
let handlers;
const pending = [];
const relay = (method, args) => { if (process.connected) process.send({ type: 'relay', method, args }); };
process.on('message', async message => {
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
	instanceId: instance.instanceId,
	onMessage(next) {
		handlers = next;
		for (const message of pending.splice(0)) handlers[message.method](...message.args);
	},
	async acquireOwner() { return instance.instanceId === 'A'; },
	async renewOwner() { return true; },
	async releaseOwner() { return true; },
	requestSync(...args) { relay('onSync', args); },
	sendSyncReply(topic, corr, _origin, payload) { relay('onSyncReply', [topic, corr, payload]); },
	relayBroadcast(...args) { relay('onBroadcast', [...args, instance.instanceId]); },
	relayCommand(...args) { relay('onCommand', args); },
	relayAck(topic, identity, _origin, payload) { relay('onAck', [topic, identity, payload]); },
	relayLeave(...args) { relay('onLeave', args); }
};
const shape = live.smooth({
	topic: (_ctx, room) => 'idle:' + room,
	topicArgs: 1,
	tickMs: 10,
	initial: { x: 0, y: 0 },
	apply: (state, cmd) => ({ x: state.x + (cmd.dx || 0), y: state.y }),
	...(instance.interest && { interest: { radius: 100, position: state => state } })
});
__register('idle/shape/__smooth/sync', shape.__smoothSync, 'idle');
process.send({ type: 'ready', url: server.wsUrl });
