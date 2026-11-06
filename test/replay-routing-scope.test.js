// A publish to a replay stream's topic writes the replay buffer whether or not
// the publishing process has a local subscriber of that topic: tenant-scoped
// wire topics resolve to their logical topic, and a stream with a topic
// factory registers its topic pattern at declaration. Asserts on the calls to
// `platform.replay.publish`, since a live frame carries a seq either way.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { live, __register, publish } from '../src/server.js';
import { state } from '../src/server/state.js';
import { _resetReplayRouting } from '../src/server/replay-routing.js';
import { mockPlatform } from './helpers/mock-platform.js';

let n = 0;
let saved;

function replayPlatform() {
	const platform = mockPlatform();
	const buffered = [];
	platform.replay = {
		publish(target, topic, event, data) { buffered.push(topic); return target.publish(topic, event, data); },
		seq: async () => 0,
		since: async () => null
	};
	return { platform, buffered };
}

beforeEach(() => { saved = state.cronPlatform; });
afterEach(() => { state.cronPlatform = saved; _resetReplayRouting(); });

describe('replay buffer routing for a publisher without a local subscriber', () => {
	it('routes a static topic, unscoped and tenant-scoped', () => {
		const topic = 'rscope-static-' + ++n;
		__register('rscope/static' + n, live.stream(topic, async () => [], { merge: 'crud', key: 'id', replay: true }));
		const { platform, buffered } = replayPlatform();
		state.cronPlatform = platform;
		publish(topic, 'created', { id: 1 });
		live.tenant('acme').publish(topic, 'created', { id: 2 });
		expect(buffered).toEqual([topic, '@t/acme/' + topic]);
		expect(platform.published.map((p) => p.topic)).toEqual([topic, '@t/acme/' + topic]);
	});

	it('routes a topic factory, unscoped and tenant-scoped', () => {
		const prefix = 'rscope-room-' + ++n + ':';
		__register('rscope/room' + n, live.stream((ctx, roomId) => prefix + roomId, async () => [], { merge: 'crud', key: 'id', replay: true }));
		const { platform, buffered } = replayPlatform();
		state.cronPlatform = platform;
		publish(prefix + '7', 'created', { id: 1 });
		live.tenant('acme').publish(prefix + '8', 'created', { id: 2 });
		expect(buffered).toEqual([prefix + '7', '@t/acme/' + prefix + '8']);
	});

	it('routes a topic factory with a literal suffix and two arguments', () => {
		const id = ++n;
		__register('rscope/doc' + id, live.stream((ctx, org, doc) => 'rscope-org-' + id + '/' + org + '/doc/' + doc, async () => [], { merge: 'crud', key: 'id', replay: true }));
		const { platform, buffered } = replayPlatform();
		state.cronPlatform = platform;
		publish('rscope-org-' + id + '/o1/doc/d1', 'created', { id: 1 });
		publish('rscope-org-' + id + '/o1/file/d1', 'created', { id: 2 });
		expect(buffered).toEqual(['rscope-org-' + id + '/o1/doc/d1']);
	});

	it('leaves topics outside the pattern and topics another stream declared to the plain publish', () => {
		const prefix = 'rscope-chat-' + ++n + ':';
		__register('rscope/chat' + n, live.stream((ctx, roomId) => prefix + roomId, async () => [], { merge: 'crud', key: 'id', replay: true }));
		__register('rscope/lobby' + n, live.stream(prefix + 'lobby', async () => [], { merge: 'crud', key: 'id' }));
		const { platform, buffered } = replayPlatform();
		state.cronPlatform = platform;
		publish(prefix + 'lobby', 'created', { id: 1 });
		live.tenant('acme').publish(prefix + 'lobby', 'created', { id: 1 });
		publish(prefix + '7:typing', 'created', { id: 2 });
		publish('rscope-other-' + n, 'created', { id: 3 });
		expect(buffered).toEqual([]);
		expect(platform.published).toHaveLength(4);
	});

	it('leaves a topic another factory stream also produces to the plain publish', () => {
		const id = ++n;
		__register('rscope/room' + id, live.stream((ctx, roomId) => 'rscope-room-' + id + '-' + roomId, async () => [], { merge: 'crud', key: 'id', replay: true }));
		__register('rscope/typing' + id, live.stream((ctx, roomId) => 'rscope-room-' + id + '-' + roomId + '-typing', async () => [], { merge: 'latest' }));
		__register('rscope/same' + id, live.stream((ctx, roomId) => 'rscope-room-' + id + '-' + roomId, async () => [], { merge: 'set' }));
		const { platform, buffered } = replayPlatform();
		state.cronPlatform = platform;
		publish('rscope-room-' + id + '-5-typing', 'set', { typing: true });
		publish('rscope-room-' + id + '-5', 'created', { id: 1 });
		expect(buffered).toEqual(['rscope-room-' + id + '-5']);
	});

	it('leaves a factory that reads ctx to its subscribe-time registration', () => {
		const prefix = 'rscope-user-' + ++n + ':';
		__register('rscope/user' + n, live.stream((ctx) => prefix + ctx.user.id, async () => [], { merge: 'crud', key: 'id', replay: true }));
		const { platform, buffered } = replayPlatform();
		state.cronPlatform = platform;
		publish(prefix + 'u1', 'created', { id: 1 });
		expect(buffered).toEqual([]);
	});

	it('warns about a missing replay extension only for a registered topic, not for a pattern match or an implicit flag', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			const id = ++n;
			__register('rscope/warn-room' + id, live.stream((ctx, roomId) => 'rscope-wroom-' + id + ':' + roomId, async () => [], { merge: 'crud', key: 'id', replay: true }));
			__register('rscope/warn-flag' + id, live.flag('rscope-wflag-' + id, false));
			__register('rscope/warn-static' + id, live.stream('rscope-wstatic-' + id, async () => [], { merge: 'crud', key: 'id', replay: true }));
			const platform = mockPlatform();
			state.cronPlatform = platform;
			publish('rscope-wroom-' + id + ':1', 'created', { id: 1 });
			live.tenant('acme').publish('rscope-wflag-' + id, 'set', true);
			const missing = () => warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('exposes no `platform.replay`'));
			expect(missing()).toEqual([]);
			live.tenant('acme').publish('rscope-wstatic-' + id, 'created', { id: 1 });
			expect(missing()).toHaveLength(1);
			expect(platform.published).toHaveLength(3);
		} finally {
			warn.mockRestore();
		}
	});
});
