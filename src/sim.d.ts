// Type declarations for the realtime deterministic simulation
// (svelte-realtime/sim).

/** A connected sim client (a thin wrapper over the testing harness client). */
export interface LiveSimClient {
	call(path: string, ...args: any[]): Promise<any>;
	subscribe(path: string, ...args: any[]): any;
	disconnect(): void;
}

/** The api passed to a scenario. */
export interface LiveSimApi {
	now(): number;
	rng(): number;
	connect(userData?: any): LiveSimClient;
	publish(topic: string, event: string, data?: any): boolean;
	/** Drain the microtask queue so async stream-init replies + publishes settle. */
	flush(): Promise<void>;
	/** Assert an RPC result; a mismatch is recorded as a `live.rpc-mismatch` violation. */
	expect(actual: any, expected: any, label: string): void;
}

export interface LiveSimConfig {
	/** Seed string; the same seed reproduces the run bit-for-bit. */
	seed?: string;
	clients?: number;
	events?: number;
	/** Simulated network loss on the publish path (all-or-nothing per publish). */
	chaos?: { dropRate: number } | null;
	/** Override the default live module (echo RPC + `feed` stream). */
	module?: () => Record<string, any>;
	/** Override the default connect/echo/subscribe/publish scenario. */
	scenario?: (api: LiveSimApi, opts: { clients: number; events: number }) => void | Promise<void>;
	gitCommit?: string;
}

export interface LiveSimResult {
	seed: string;
	gitCommit: string | null;
	config: { clients: number; events: number; chaos: { dropRate: number } | null };
	invariantViolations: Array<{ category: string; context: any }>;
	metrics: { clients: number; events: number; rpcChecks: number; chaosDropped: number };
	/** Per-subscriber received event sequences (for inspection + the replay gate). */
	clientFrames: any[][];
	finalState: {
		topics: string[];
		perTopic: Array<{ topic: string; subscribers: number; events: number }>;
		rpcChecks: number;
	};
	/** True only on a replayLiveSim result whose violations + state + frames + metrics matched. */
	reproduced?: boolean;
}

export function runLiveSim(config?: LiveSimConfig): Promise<LiveSimResult>;
export function replayLiveSim(reproducer: LiveSimResult): Promise<LiveSimResult>;

/** One run's compact outcome within a swarm (fatals/uncaught are always 0 for
 *  the realtime tier; kept for cross-tier shape parity). */
export interface LiveSimSwarmRun {
	seed: string;
	ok: boolean;
	faulted: boolean;
	fingerprint: string;
	violations: number;
	fatals: number;
	uncaught: number;
	violationCategories: string[];
	reproduced: boolean | null;
}

export interface LiveSimSwarmSummary {
	total: number;
	passed: number;
	failed: number;
	firstFailingSeed: string | null;
	failingSeeds: string[];
	faultMode: 'off' | 'on' | 'random';
	faulted: number;
	determinismChecks: number;
	determinismFailures: number;
	determinismFailingSeeds: string[];
	gitCommit: string | null;
	ok: boolean;
}

export interface LiveSimSwarmConfig {
	seeds?: Array<string | number>;
	count?: number;
	startSeed?: number;
	base?: LiveSimConfig;
	faultMode?: 'off' | 'on' | 'random';
	/** Chaos profile applied when a run is faulted (default { dropRate: 0.2 }). */
	faultProfile?: { dropRate?: number };
	faultProbability?: number;
	checkRatio?: number;
	gitCommit?: string;
	onResult?: (run: LiveSimSwarmRun, index: number) => void;
}

export interface LiveSimSwarmResult {
	summary: LiveSimSwarmSummary;
	runs: LiveSimSwarmRun[];
}

export function runLiveSimSwarm(config?: LiveSimSwarmConfig): Promise<LiveSimSwarmResult>;

export const DEFAULT_LIVE_SEED: string;
export const FIXED_EPOCH: number;

// --- Lag-compensation ("deterministic netcode") sim --------------------------
// Drives the server-rewind shot-resolution path: a seeded latency-varying shot
// stream over a moving board must reproduce every hit bit-for-bit under one seed.

export interface SmoothSimConfig {
	/** Seed string; the same seed reproduces the run bit-for-bit. */
	seed?: string;
	/** Entity count (1 shooter + the rest targets); minimum 2. */
	entities?: number;
	/** Ticks of board motion recorded into the lag-comp ring. */
	ticks?: number;
	/** Shots fired in the seeded stream. */
	shots?: number;
	/** Tick interval (ms); sizes the ring and the cadence estimate. */
	tickMs?: number;
	/** The favor-shooter rewind cap (ms). */
	maxRewindMs?: number;
	/** Area-of-interest cull radius (position units). */
	radius?: number;
	/** Widen the shot lag past the reach and teleport a target mid-run, exercising
	 *  the reach clamp / window fallback / discontinuity guard. */
	faultMode?: boolean;
	/** Fold an extra value into each hit record (a hook to plant a non-determinism). */
	onHitTap?: (target: any, info: any) => any;
	gitCommit?: string;
}

export interface SmoothSimResult {
	seed: string;
	gitCommit: string | null;
	config: {
		entities: number;
		ticks: number;
		shots: number;
		tickMs: number;
		maxRewindMs: number;
		radius: number;
		faultMode: boolean;
	};
	invariantViolations: Array<{ category: string; context: any }>;
	metrics: {
		entities: number;
		ticks: number;
		shots: number;
		hits: number;
		dropped: number;
		injected: number;
		events: number;
	};
	/** Every resolved hit, nearest-first per shot (the determinism signal). */
	hitLog: Array<{
		key: string;
		dist: number;
		fraction: number;
		rewindAt: number;
		fallback: boolean;
		px: number;
		py: number;
		tap?: any;
	}>;
	/** Per-shot reach / rewind measurements (or `{ dropped: true }` for a replay-dropped shot). */
	shotResults: any[];
	finalState: {
		entities: number;
		ticks: number;
		shots: number;
		injected: number;
		events: number;
		hitCount: number;
	};
	/** True only on a replaySmoothSim result whose violations + state + hits + shots + metrics matched. */
	reproduced?: boolean;
}

export function runSmoothSim(config?: SmoothSimConfig): Promise<SmoothSimResult>;
export function replaySmoothSim(reproducer: SmoothSimResult): Promise<SmoothSimResult>;

export interface SmoothSimSwarmRun {
	seed: string;
	ok: boolean;
	faulted: boolean;
	fingerprint: string;
	violations: number;
	fatals: number;
	uncaught: number;
	violationCategories: string[];
	reproduced: boolean | null;
	hits: number;
}

export interface SmoothSimSwarmSummary {
	total: number;
	passed: number;
	failed: number;
	firstFailingSeed: string | null;
	failingSeeds: string[];
	faultMode: 'off' | 'on' | 'random';
	faulted: number;
	determinismChecks: number;
	determinismFailures: number;
	determinismFailingSeeds: string[];
	gitCommit: string | null;
	ok: boolean;
}

export interface SmoothSimSwarmConfig {
	seeds?: Array<string | number>;
	count?: number;
	startSeed?: number;
	base?: SmoothSimConfig;
	faultMode?: 'off' | 'on' | 'random';
	faultProbability?: number;
	checkRatio?: number;
	gitCommit?: string;
	onResult?: (run: SmoothSimSwarmRun, index: number) => void;
}

export interface SmoothSimSwarmResult {
	summary: SmoothSimSwarmSummary;
	runs: SmoothSimSwarmRun[];
}

export function runSmoothSimSwarm(config?: SmoothSimSwarmConfig): Promise<SmoothSimSwarmResult>;

export const DEFAULT_SMOOTH_SEED: string;

// - Golden-set regression gate ------------------------------------------------

/** One committed golden: a seed's structural fingerprint + a triage digest. */
export interface SimGoldenEntry {
	seed: string;
	/** Drift budget weight; 0 = watch-list (reported, never gates). @default 1 */
	weight: number;
	fingerprint: string;
	digest: {
		violations: number;
		fatals: number;
		uncaught: number;
		violationCategories: string[];
		faulted: boolean;
	};
}

/** A committed golden corpus: entries plus the swarm config they are only comparable under. */
export interface SimGoldenCorpus {
	schemaVersion: 1;
	gitCommit: string | null;
	recordedAt: string | null;
	swarm: object | null;
	entries: SimGoldenEntry[];
}

/** One drifted seed in a golden check: the recorded vs the freshly-observed
 *  fingerprint + digest, for triage. */
export interface SimGoldenDrift {
	seed: string;
	weight: number;
	kind: 'changed' | 'missing';
	golden: { fingerprint: string; digest: SimGoldenEntry['digest'] };
	/** null when the seed was missing from the run. */
	actual: { fingerprint: string; digest: SimGoldenEntry['digest'] } | null;
}

/** The result of checking a corpus against a fresh swarm. */
export interface SimGoldenReport {
	/** True iff there is no config mismatch and driftWeight <= maxDriftWeight. */
	ok: boolean;
	totalWeight: number;
	driftWeight: number;
	maxDriftWeight: number;
	/** Drifted seeds, sorted weight-desc then seed. */
	drifts: SimGoldenDrift[];
	/** Non-null when the run's swarm config is incomparable to the corpus. */
	configMismatch: string | null;
	counts: { changed: number; missing: number; added: number; matched: number };
}

/**
 * Project a swarm result (live or smooth) into a committable golden corpus. Pure.
 */
export function buildSimGoldens(
	swarmResult: LiveSimSwarmResult | SmoothSimSwarmResult,
	opts?: { weights?: Record<string, number>; gitCommit?: string | null; recordedAt?: string | null; swarm?: object | null }
): SimGoldenCorpus;

/** Compare a golden corpus against a fresh swarm result (weighted drift gate). Pure. */
export function checkSimGoldens(
	golden: SimGoldenCorpus,
	swarmResult: LiveSimSwarmResult | SmoothSimSwarmResult,
	opts?: { maxDriftWeight?: number }
): SimGoldenReport;
