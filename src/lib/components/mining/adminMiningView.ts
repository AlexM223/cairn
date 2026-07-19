// Local view-model types for the admin `/admin/mining` surface (cairn-vn43.10).
//
// These mirror the shape `getAdminMiningView()` (src/lib/server/mining/readModels,
// built in the same wave by a concurrent worker) returns, and what
// `GET /api/admin/mining` re-serves on every poll. Defined here (not imported
// from the server module) so this route's UI has a stable structural contract
// to typecheck against even while the server module is still landing —
// `+page.server.ts` narrows/casts the real return value against this shape.
//
// Kept in a plain `.ts` file (not a `.svelte` component) so every Admin*
// component and the route's `+page.server.ts`/`+page.svelte` can import the
// same types without a cross-boundary `<script module>` re-export dance.

export type MiningEngineStatus = 'running' | 'stopped' | 'core_missing';
export type CoreRpcState = 'ok' | 'down' | 'unconfigured';
export type MiningBind = 'loopback' | 'lan' | 'all';
export type MiningBlockStatus = 'maturing' | 'mature' | 'rejected';

export interface AdminMiningEngineView {
	status: MiningEngineStatus;
	coreRpc: CoreRpcState;
	uptimeSec: number;
	bind: MiningBind;
	stratumPort: number;
	/** Seconds since the last getblocktemplate refresh, or null if never. */
	lastTemplateAgoSec: number | null;
	fatalErrors: string[];
	/** Per-listener breakdown (standard + optional ASIC port, cairn-pz8v5). */
	listeners: { role: 'standard' | 'asic'; port: number; connections: number }[];
}

/** Friendly label for the engine's configured network exposure. */
export function bindLabel(bind: MiningBind): string {
	if (bind === 'loopback') return 'this device only';
	if (bind === 'lan') return 'this network (LAN)';
	return 'any network';
}

export interface AdminMiningPoolView {
	connectedWorkers: number;
	connectedUsers: number;
	/** Instantaneous pool hashrate estimate, H/s. */
	hashrateNow: number;
	/** 24h-trailing pool hashrate estimate, H/s. */
	hashrate24h: number;
}

export interface AdminMiningHashratePoint {
	/** Unix milliseconds (matches `Date.parse()`/`Date.now()` — NOT seconds). */
	t: number;
	/** H/s. */
	hashrate: number;
}

export interface AdminMinerRow {
	userId: number;
	userName: string;
	worker: string;
	/** H/s. */
	hashrate: number;
	difficulty: number;
	lastShareAgoSec: number | null;
	online: boolean;
}

export interface AdminUserBreakdownRow {
	userId: number;
	userName: string;
	workers: number;
	/** H/s. */
	hashrate: number;
	sharePct: number;
}

export interface AdminBlockRow {
	height: number;
	blockHash: string;
	foundByName: string;
	/** Sats. */
	reward: number;
	/** ISO datetime string (DB `found_at` column — NOT a unix-seconds number). */
	foundAt: string;
	confirmations: number;
	status: MiningBlockStatus;
}

export interface AdminMiningSettingsView {
	enabled: boolean;
	bind: MiningBind;
	port: number;
	shareDifficulty: number;
	vardiffEnabled: boolean;
	vardiffTargetPerMin: number;
	poolTag: string;
	/** Second (ASIC-class) high-floor Stratum listener. */
	asicPortEnabled: boolean;
	asicStratumPort: number;
	asicShareDifficulty: number;
}

export interface AdminMiningView {
	engine: AdminMiningEngineView;
	pool: AdminMiningPoolView;
	hashrateSeries: AdminMiningHashratePoint[];
	miners: AdminMinerRow[];
	userBreakdown: AdminUserBreakdownRow[];
	blocks: AdminBlockRow[];
	settings: AdminMiningSettingsView;
}

/** A duration in seconds, in the roundest sensible unit (mirrors the admin overview's uptime readout). */
export function formatUptime(seconds: number): string {
	if (!Number.isFinite(seconds) || seconds < 0) return '—';
	if (seconds >= 172_800) return `${Math.floor(seconds / 86_400)} days`;
	if (seconds >= 7_200) return `${Math.floor(seconds / 3_600)} hours`;
	if (seconds >= 120) return `${Math.floor(seconds / 60)} minutes`;
	return 'just started';
}

/** `n` seconds ago, in the roundest sensible unit; `null`/negative renders as an em-dash. */
export function agoLabel(seconds: number | null | undefined): string {
	if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return '—';
	if (seconds < 60) return `${Math.floor(seconds)}s ago`;
	const mins = Math.floor(seconds / 60);
	if (mins < 60) return `${mins}m ago`;
	const hours = Math.floor(mins / 60);
	if (hours < 24) return `${hours}h ago`;
	return `${Math.floor(hours / 24)}d ago`;
}

/**
 * Fallback shape when `getAdminMiningView()` throws (the engine module isn't
 * wired up yet, or a live read failed) — lets the page render a calm "nothing
 * running" state instead of a 500, per this route's degraded-load contract.
 */
export const DEGRADED_ADMIN_MINING_VIEW: AdminMiningView = {
	engine: {
		status: 'core_missing',
		coreRpc: 'unconfigured',
		uptimeSec: 0,
		bind: 'loopback',
		stratumPort: 3333,
		lastTemplateAgoSec: null,
		fatalErrors: [],
		listeners: []
	},
	pool: {
		connectedWorkers: 0,
		connectedUsers: 0,
		hashrateNow: 0,
		hashrate24h: 0
	},
	hashrateSeries: [],
	miners: [],
	userBreakdown: [],
	blocks: [],
	settings: {
		enabled: false,
		bind: 'loopback',
		port: 3333,
		shareDifficulty: 1,
		vardiffEnabled: true,
		vardiffTargetPerMin: 10,
		poolTag: 'Heartwood',
		asicPortEnabled: true,
		asicStratumPort: 3334,
		asicShareDifficulty: 65536
	}
};
