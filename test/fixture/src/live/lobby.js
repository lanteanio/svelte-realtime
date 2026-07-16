// Live module backing the cluster lobby e2e (test/chaos/room-lobby-cluster.spec.js).
//
// The full coordination-heavy room shape on one export: a dynamic topic with
// enumeration (the rooms() lobby browser), ownership (first joiner claims,
// deterministic succession), and presence. With REDIS_URL set the chaos
// harness wires `platform.redis`, so the enumeration registry, the presence
// roster, and the owner store are all cluster-shared across the two
// instances - the exact production topology the demo lobbies run.

import { live } from 'svelte-realtime/server';

export const lobby = live.room({
	topic: (ctx, id) => 'lobby:' + id,
	topicArgs: 1,
	init: async () => [],
	meta: (id) => ({ name: 'Table ' + id, cap: 8 }),
	enumerable: true,
	owner: true,
	presence: (ctx) => ({ name: ctx.user.id })
});
