// @ts-check
import {
	now as runtimeNow,
	randomFloat,
	randomU32,
	randomUuid,
	randomBytes
} from '../shared/runtime.js';

// Runtime-backed RNG fallback for ctx.random when the adapter platform does
// not expose its own injectable RNG (older adapters, mock platforms). Shape
// matches the adapter's platform.random so a loader/handler reads one stable
// interface regardless of which side supplies it. Frozen singleton so the
// fallback object identity never changes.
export const _runtimeRandom = Object.freeze({
	float: randomFloat,
	u32: randomU32,
	uuid: randomUuid,
	bytes: randomBytes
});

// Runtime-backed hybrid logical clock fallback for ctx.hlc when the adapter
// platform does not project its own (older adapters, mock platforms). Same
// {wall, logical, nodeId} shape and non-decreasing wall + logical-tiebreaker
// rule the adapter uses, but sourced from this framework's own runtime clock
// and RNG so a seeded simulation harness reproduces the stamps. nodeId is
// assigned once per process from the runtime RNG.
const _localHlcNodeId = randomUuid().slice(0, 8);
let _localHlcLastWall = 0;
let _localHlcLogical = 0;
export function _localHlc() {
	const w = runtimeNow();
	if (w > _localHlcLastWall) {
		_localHlcLastWall = w;
		_localHlcLogical = 0;
	} else {
		_localHlcLogical += 1;
	}
	return { wall: _localHlcLastWall, logical: _localHlcLogical, nodeId: _localHlcNodeId };
}
