// Each process has its own topic registries; IPC carries the cluster publish.
import { createTestServer } from 'svelte-adapter-uws/testing';
import { createReplay } from 'svelte-adapter-uws/plugins/replay';
import { live, realtime, __register, setBus, _activateDerived, publish } from '../../src/server.js';
import { _buildCtx, _getCtxHelpers } from '../../src/server/ctx.js';
import { _declaredRedact, _topicRedact, state } from '../../src/server/state.js';
import { _registerReplayTopic } from '../../src/server/replay-routing.js';

const publisher = process.argv[2] === 'publisher';
__register('private/feed', live.public(live.stream((ctx, room) => 'private:' + room, async () => null, {
	piiRedact: data => ({ text: data.author.text }),
	onError() { throw new Error('Observer failed'); }
})));
__register('private/typing', live.public(live.channel('private:typing')));
const server = await createTestServer({ handler: realtime() });
if (publisher) {
	setBus({ wrap(platform) {
		const wrapped = Object.create(platform);
		wrapped.publish = (topic, event, data, options) => {
			const result = platform.publish(topic, event, data, options);
			process.send({ type: 'relay', topic, event, data });
			return result;
		};
		wrapped.publishBatched = messages => {
			for (const message of messages) wrapped.publish(message.topic, message.event, message.data, message.options);
		};
		return wrapped;
	} });
	_activateDerived(server.platform);
	state.cronPlatform = server.platform;
	server.platform.replay = createReplay({ size: 10 });
	_registerReplayTopic('private:room');
}
process.on('message', async message => {
	if (message.type === 'stop') {
		await server.close();
		process.disconnect();
		return;
	}
	if (message.type === 'relay') {
		server.platform.publish(message.topic, message.event, message.data, { seq: false });
		return;
	}
	if (message.type !== 'publish') return;
	const ctx = _buildCtx(null, null, server.platform, _getCtxHelpers(server.platform), null);
	const send = (topic, data) => {
		if (message.method === 'batch') ctx.batch([{ topic, event: 'set', data }]);
		else if (message.method === 'out-of-band') publish(topic, 'set', data);
		else ctx[message.method](topic, 'set', data, 5);
	};
	send('private:room', { ssn: 'NEVER-SEND' });
	await new Promise(resolve => setTimeout(resolve, 15));
	const rejectedSeq = await server.platform.replay.seq('private:room');
	send('private:room', { author: { text: message.id }, ssn: 'NEVER-SEND' });
	send('private:typing', { typing: message.id });
	await new Promise(resolve => setTimeout(resolve, 15));
	process.send({ type: 'published', id: message.id, rejectedSeq,
		exact: _declaredRedact.has('private:room') || _topicRedact.has('private:room') });
});
process.send({ type: 'ready', url: server.wsUrl });
