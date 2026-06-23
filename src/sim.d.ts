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
	buggified: boolean;
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
	buggify: 'off' | 'on' | 'random';
	buggified: number;
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
	buggify?: 'off' | 'on' | 'random';
	/** Chaos profile applied when a run is buggified (default { dropRate: 0.2 }). */
	faultProfile?: { dropRate?: number };
	buggifyProbability?: number;
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
