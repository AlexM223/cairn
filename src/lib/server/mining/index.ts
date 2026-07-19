/**
 * Mining engine lifecycle + Heartwood integration bridge (cairn-vn43.4/.6/.8).
 *
 * The engine runs IN-PROCESS (no child-process supervisor — cairn-vn43.12 is
 * obsolete): one MiningPool per instance, its auth snapshot and share
 * accounting owned by this module. Everything here is best-effort and never
 * throws into its callers — a mining failure must never take down the app or a
 * financial operation. Fatal conditions accumulate in {@link fatalErrors} and
 * surface in the admin status view.
 *
 * Wiring:
 *   MiningPool.onShare   → aggregates.recordShare + best-share milestone notify
 *   MiningPool.onReject  → aggregates.recordReject
 *   MiningPool.onBlockAccepted → advance the finder's receive cursor, record the
 *                          block row, notify finder + admins, log activity
 *   MiningPool.onBlockRejected → record a 'rejected:<reason>' block row, loud log
 *   60s timer            → refreshAuthTable (also on start + prefs-change)
 *   60s timer            → worker-offline watcher
 *   15s timer            → aggregates flush (owned by MiningAggregates)
 */
import { MiningPool } from './miningPool';
import { getAuthTable, refreshAuthTable } from './authTable';
import { MiningAggregates } from './aggregates';
import { publish as livePublish } from '../liveHub';
import { readMiningSettings } from './settings';
import { networkFor } from './address';
import type { MiningEngineConfig, SolveEvent, ShareEvent, RejectEvent, EngineStatus } from './types';
import { getChain } from '../chain';
import { getChainConfig } from '../settings';
import { isFeatureEnabled } from '../featureFlags/resolve';
import { nextReceiveAddress } from '../wallets';
import { notify } from '../notifications';
import { recordActivity } from '../activity';
import { db } from '../db';
import { childLogger } from '../logger';

const log = childLogger('mining:engine');

// Engine-config constants NOT exposed as admin settings (sane fixed values).
const MAX_CONNECTIONS = 128;
/** Vardiff ceiling — a float64 overflow guard, generous for any home miner. */
const MAX_DIFFICULTY = 2 ** 40;
/** 0 = production solve gate (network target). Never shifted outside regtest. */
const BLOCK_POLICY_SHIFT = 0;

const AUTH_REFRESH_MS = 60_000;
const OFFLINE_SCAN_MS = 60_000;
const OFFLINE_ESTABLISHED_MS = 10 * 60_000; // ≥10min of shares before we watch it
const OFFLINE_SILENCE_MS = 5 * 60_000; // silent >5min = offline
const BEST_SHARE_THROTTLE_MS = 86_400_000; // ≤1 best-share notify / user / day
const NETWORK_HASHPS_TTL_MS = 60_000;

// ------------------------------------------------------------- module state
const aggregates = new MiningAggregates();
let pool: MiningPool | null = null;
let startedAt: number | null = null;
let startInFlight: Promise<void> | null = null;
let authRefreshTimer: NodeJS.Timeout | null = null;
let offlineTimer: NodeJS.Timeout | null = null;
const fatal: string[] = [];

/** currently-offline episodes, keyed userId:worker (dedupe one notify/episode). */
const offlineNotified = new Set<string>();
/** in-memory all-time best-share baseline + last-notify time, per user. */
const bestBaseline = new Map<number, number>();
const bestLastNotify = new Map<number, number>();

let netHashCache: { at: number; value: number | null } | null = null;
let shutdownHooked = false;

/**
 * Durable shutdown flush. server.mjs runs in a SEPARATE module graph from this
 * (bundled) code — it imports ./build/handler.js and has no clean handle to this
 * singleton, so its SIGTERM/SIGINT handler can't await stopMiningEngine() here
 * (a dynamic import from server.mjs would spawn a second, empty-state instance
 * that flushes nothing). Instead the engine registers its OWN signal handler,
 * once, when it first starts: a SYNCHRONOUS final flush of accumulated shares
 * (aggregates.flush is sync SQLite). It's registered during app-bundle import,
 * which finishes before server.mjs registers its own signal handlers, so this
 * runs first — durability is guaranteed before the process exits. The pool's TCP
 * listener is closed by process exit. See the bridge report's shutdown note.
 */
function ensureShutdownFlush(): void {
	if (shutdownHooked) return;
	shutdownHooked = true;
	const onSignal = (): void => {
		try {
			aggregates.flush();
		} catch {
			/* best-effort */
		}
	};
	process.once('SIGTERM', onSignal);
	process.once('SIGINT', onSignal);
}

export function getMiningAggregates(): MiningAggregates {
	return aggregates;
}

export function miningEngineRunning(): boolean {
	return pool !== null;
}

/** Prefs-change hook (prefs.ts calls this). Rebuild the auth snapshot off the
 *  hot path — but only when the engine is actually running (no point paying for
 *  a chain round-trip to derive addresses nobody will authorize against). */
export function onPrefsChanged(): void {
	if (pool !== null) void refreshAuthTable();
}

function recordFatal(msg: string): void {
	fatal.push(msg);
	if (fatal.length > 50) fatal.shift();
	log.error({ msg }, 'mining engine fatal');
}

function buildEngineConfig(): MiningEngineConfig {
	const s = readMiningSettings();
	return {
		bindHost: s.bindHost,
		port: s.stratumPort,
		network: networkFor(getChainConfig().network),
		poolTag: s.poolTag,
		shareDifficulty: s.shareDifficulty,
		vardiffEnabled: s.vardiffEnabled,
		vardiffTargetPerMin: s.vardiffTargetPerMin,
		maxDifficulty: MAX_DIFFICULTY,
		maxConnections: MAX_CONNECTIONS,
		blockPolicyShift: BLOCK_POLICY_SHIFT,
		asicPortEnabled: s.asicPortEnabled,
		asicPort: s.asicStratumPort,
		asicShareDifficulty: s.asicShareDifficulty
	};
}

/**
 * Start the engine, idempotently. No-op (never throws) unless ALL gates hold:
 * the `mining` feature flag is on instance-wide, the operator enabled mining in
 * settings, and a Bitcoin Core RPC backend is configured. Concurrent callers
 * share one in-flight start.
 */
export function startMiningEngine(): Promise<void> {
	if (pool !== null) return Promise.resolve();
	if (startInFlight) return startInFlight;
	startInFlight = doStart().finally(() => {
		startInFlight = null;
	});
	return startInFlight;
}

async function doStart(): Promise<void> {
	try {
		if (!isFeatureEnabled('mining', null)) return;
		if (!readMiningSettings().enabled) return;
		const chain = getChain();
		if (!chain.coreConfigured || !chain.core) {
			log.info('mining engine not started: Bitcoin Core RPC not configured');
			return;
		}

		// Build the auth snapshot BEFORE listening so the first connecting miner
		// resolves against a populated table.
		await refreshAuthTable();
		aggregates.startFlushTimer();
		ensureShutdownFlush();

		const config = buildEngineConfig();
		const engine = new MiningPool({
			rpc: chain.core,
			config,
			authProvider: getAuthTable(),
			onShare: (e) => onShare(e),
			onReject: (e) => onReject(e),
			onBlockAccepted: (solve, blockHash, coinbaseTxid) =>
				void handleBlockAccepted(solve, blockHash, coinbaseTxid),
			onBlockRejected: (solve, reason) => handleBlockRejected(solve, reason),
			log: (msg) => log.info(msg)
		});
		await engine.start();
		pool = engine;
		startedAt = Date.now();

		authRefreshTimer = setInterval(() => void refreshAuthTable(), AUTH_REFRESH_MS);
		authRefreshTimer.unref?.();
		offlineTimer = setInterval(() => scanOffline(), OFFLINE_SCAN_MS);
		offlineTimer.unref?.();

		log.info({ port: config.port, bind: config.bindHost }, 'mining engine started');
	} catch (e) {
		recordFatal(e instanceof Error ? e.message : String(e));
	}
}

/** Stop the engine: halt the pool, clear timers, do a final flush. Never throws. */
export async function stopMiningEngine(): Promise<void> {
	const engine = pool;
	pool = null;
	startedAt = null;
	if (authRefreshTimer) {
		clearInterval(authRefreshTimer);
		authRefreshTimer = null;
	}
	if (offlineTimer) {
		clearInterval(offlineTimer);
		offlineTimer = null;
	}
	try {
		if (engine) await engine.stop();
	} catch (e) {
		log.warn({ err: e }, 'mining pool stop failed');
	}
	// Durability: one last flush of accumulated shares, then park the timer.
	try {
		aggregates.flush();
	} catch (e) {
		log.warn({ err: e }, 'final aggregates flush failed');
	}
	aggregates.stopFlushTimer();
	offlineNotified.clear();
}

/** Full stop + start with freshly-read settings (called after a settings save
 *  or a chain reconfigure). Never throws. */
export async function reconfigureMiningEngine(): Promise<void> {
	try {
		await stopMiningEngine();
	} catch (e) {
		log.warn({ err: e }, 'reconfigure: stop failed');
	}
	await startMiningEngine();
}

export type CoreRpcStatus = 'ok' | 'down' | 'unconfigured';

export interface MiningEngineStatus {
	running: boolean;
	engine: EngineStatus | null;
	coreRpc: CoreRpcStatus;
	startedAt: number | null;
}

export function miningEngineStatus(): MiningEngineStatus {
	const engine = pool ? pool.status() : null;
	let coreRpc: CoreRpcStatus;
	if (!getChain().coreConfigured) coreRpc = 'unconfigured';
	else if (engine && engine.lastTemplateOk) coreRpc = 'ok';
	else coreRpc = 'down';
	return {
		running: pool !== null,
		engine,
		coreRpc,
		startedAt
	};
}

/** Fatal errors accumulated by the bridge (distinct from the pool's own). */
export function miningFatalErrors(): string[] {
	const poolFatal = pool ? [...pool.fatalErrors] : [];
	return [...fatal, ...poolFatal];
}

/** Network hashrate (H/s), cached ~60s. Null when Core can't answer. */
export async function getNetworkHashps(): Promise<number | null> {
	const now = Date.now();
	if (netHashCache && now - netHashCache.at < NETWORK_HASHPS_TTL_MS) return netHashCache.value;
	let value: number | null = null;
	try {
		const core = getChain().core;
		if (core) {
			const v = await core.getNetworkHashPs();
			value = Number.isFinite(v) && v > 0 ? v : null;
		}
	} catch (e) {
		log.warn({ err: e }, 'getnetworkhashps failed');
		value = null;
	}
	netHashCache = { at: now, value };
	return value;
}

// -------------------------------------------------------------- share hooks

function onShare(e: ShareEvent): void {
	try {
		aggregates.recordShare(e);
		maybeBestShareNotify(e);
	} catch (err) {
		log.warn({ err }, 'onShare handler failed');
	}
}

function onReject(e: RejectEvent): void {
	try {
		aggregates.recordReject(e);
	} catch (err) {
		log.warn({ err }, 'onReject handler failed');
	}
}

/** All-time best share for a user, seeded from the DB mirror on first look. */
function allTimeBest(userId: number): number {
	if (bestBaseline.has(userId)) return bestBaseline.get(userId)!;
	let best = 0;
	try {
		const row = db
			.prepare('SELECT MAX(best_share_diff) AS best FROM mining_workers WHERE user_id = ?')
			.get(userId) as { best: number | null } | undefined;
		best = row?.best ?? 0;
	} catch (e) {
		log.warn({ err: e, userId }, 'best-share baseline read failed');
	}
	bestBaseline.set(userId, best);
	return best;
}

/**
 * Notify on a new all-time best share that is at least DOUBLE the previous
 * stored best — a genuine milestone, not every tiny new max. Throttled to at
 * most one per user per day. Only fires once a baseline exists (the first-ever
 * best just seeds the baseline silently).
 */
export function maybeBestShareNotify(e: ShareEvent): void {
	const d = e.difficulty;
	if (!Number.isFinite(d) || d <= 0) return;
	const baseline = allTimeBest(e.userId);
	if (d <= baseline) return; // not a new best
	bestBaseline.set(e.userId, d); // advance baseline regardless of notifying
	if (baseline <= 0) return; // first-ever best: seed only, no notification
	if (d < baseline * 2) return; // new best, but not a doubling milestone
	const now = Date.now();
	const last = bestLastNotify.get(e.userId) ?? 0;
	if (now - last < BEST_SHARE_THROTTLE_MS) return;
	bestLastNotify.set(e.userId, now);
	notify({
		type: 'mining_best_share',
		userId: e.userId,
		level: 'info',
		title: 'New best share!',
		body: `Your miner ${e.worker} just submitted a share of difficulty ${Math.round(d).toLocaleString()} — a new personal best.`,
		detail: { worker: e.worker, difficulty: d },
		link: '/mining'
	});
}

// -------------------------------------------------------------- block hooks

export async function handleBlockAccepted(
	solve: SolveEvent,
	blockHash: string,
	coinbaseTxid: string
): Promise<void> {
	// (a) Advance the finder's receive cursor exactly once — the payout address
	// this block paid must not be handed out again for a future receive.
	try {
		await nextReceiveAddress(solve.userId, solve.walletId);
	} catch (e) {
		log.warn({ err: e, userId: solve.userId, walletId: solve.walletId }, 'receive cursor advance failed');
	}

	// (b) Record the block row (durable). block_hash is UNIQUE — a duplicate
	// callback (should never happen) is swallowed rather than throwing.
	try {
		db.prepare(
			`INSERT INTO mining_blocks
			   (height, block_hash, coinbase_txid, user_id, worker_name, wallet_id,
			    payout_address, coinbase_value_sats, submit_result)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'accepted')`
		).run(
			solve.height,
			blockHash,
			coinbaseTxid,
			solve.userId,
			solve.worker,
			solve.walletId,
			solve.address,
			solve.coinbaseValueSats.toString()
		);
	} catch (e) {
		log.error({ err: e, height: solve.height, blockHash }, 'mining_blocks insert (accepted) failed');
	}

	const rewardSats = solve.coinbaseValueSats.toString();

	// (c) Notify the finder (success, deep-link to /mining) + broadcast to admins.
	// Quiet-hours note: notify() has no per-call urgency override — the queue
	// worker applies quiet hours by LEVEL (info/success deferred; warn/error honor
	// the user's urgentOverride). block_found is 'success', so on external channels
	// it defers to the window's end during quiet hours; the in-app record is always
	// instant. Documented rather than special-cased (see bridge report).
	try {
		notify({
			type: 'mining_block_found',
			userId: solve.userId,
			level: 'success',
			title: 'You found a block!',
			body: `Your miner ${solve.worker} found block ${solve.height}. The full reward pays your wallet — it becomes spendable after 100 confirmations.`,
			detail: {
				height: solve.height,
				blockHash,
				coinbaseTxid,
				rewardSats,
				worker: solve.worker,
				address: solve.address
			},
			link: '/mining'
		});
	} catch (e) {
		log.warn({ err: e }, 'block-found user notify failed');
	}
	try {
		notify({
			type: 'mining_block_found',
			userId: null,
			level: 'info',
			title: 'A miner found a block',
			body: `Block ${solve.height} was found on this instance. The reward pays the finder's wallet.`,
			detail: { height: solve.height, blockHash, userId: solve.userId, rewardSats },
			link: '/admin/mining'
		});
	} catch (e) {
		log.warn({ err: e }, 'block-found admin notify failed');
	}

	// Immediate live nudge (docs/LIVE-UPDATES-DESIGN.md §2/§3.4): block-found is
	// out of band — nudge the finder and admins now rather than waiting for the
	// next aggregates flush. Nudge-only; the client refetches its own view.
	try {
		livePublish('mining', { userId: solve.userId }, {});
		// Pool nudges are becoming user-visible (cairn-et38g): broadcast to every
		// entitled connection rather than admins only. The nudge carries NO data —
		// the underlying data endpoint stays access-gated; clients refetch their own
		// permitted view.
		livePublish('mining:pool', { broadcast: true }, {});
	} catch (e) {
		log.warn({ err: e }, 'block-found live nudge failed');
	}

	// (d) Activity feed.
	try {
		recordActivity({
			type: 'mining_block_found',
			message: `Block ${solve.height} found — full reward to wallet ${solve.walletId}`,
			level: 'success',
			userId: solve.userId,
			detail: { height: solve.height, blockHash, rewardSats }
		});
	} catch (e) {
		log.warn({ err: e }, 'block-found activity record failed');
	}
}

export function handleBlockRejected(solve: SolveEvent, reason: string): void {
	log.error({ height: solve.height, reason }, 'BLOCK REJECTED by bitcoind');
	try {
		// A rejected solve has no accepted block hash; store a synthetic unique key
		// so the UNIQUE(block_hash) constraint never collides across rejections.
		const key = `rejected:${solve.height}:${solve.nonceHex}:${Date.now()}`;
		db.prepare(
			`INSERT INTO mining_blocks
			   (height, block_hash, coinbase_txid, user_id, worker_name, wallet_id,
			    payout_address, coinbase_value_sats, submit_result)
			 VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?)`
		).run(
			solve.height,
			key,
			solve.userId,
			solve.worker,
			solve.walletId,
			solve.address,
			solve.coinbaseValueSats.toString(),
			`rejected:${reason}`
		);
	} catch (e) {
		log.error({ err: e, height: solve.height }, 'mining_blocks insert (rejected) failed');
	}
}

// ----------------------------------------------------------- offline watcher

/**
 * Scan for workers that were established (≥10min of shares) then went silent
 * (>5min). Notify once per offline episode; a worker that resumes clears its
 * episode so a later silence can notify again. Multiple newly-offline workers of
 * ONE user in the same scan collapse into a single notification.
 */
function scanOffline(): void {
	try {
		const now = Date.now();
		const newlyOfflineByUser = new Map<number, string[]>();
		const liveKeys = new Set<string>();
		for (const w of aggregates.liveAllMiners()) {
			const key = `${w.userId}:${w.worker}`;
			liveKeys.add(key);
			if (w.lastShareAtMs === null || w.firstShareAtMs === null) continue;
			const established = w.lastShareAtMs - w.firstShareAtMs >= OFFLINE_ESTABLISHED_MS;
			const silent = now - w.lastShareAtMs > OFFLINE_SILENCE_MS;
			if (established && silent) {
				if (!offlineNotified.has(key)) {
					offlineNotified.add(key);
					const list = newlyOfflineByUser.get(w.userId) ?? [];
					list.push(w.worker);
					newlyOfflineByUser.set(w.userId, list);
				}
			} else if (!silent) {
				offlineNotified.delete(key); // resumed → episode over
			}
		}
		// Forget episodes for workers no longer tracked at all.
		for (const key of [...offlineNotified]) {
			if (!liveKeys.has(key)) offlineNotified.delete(key);
		}
		for (const [userId, workers] of newlyOfflineByUser) {
			const body =
				workers.length === 1
					? `Your miner ${workers[0]} stopped submitting shares.`
					: `${workers.length} of your miners stopped submitting shares (${workers.slice(0, 3).join(', ')}${workers.length > 3 ? '…' : ''}).`;
			notify({
				type: 'mining_worker_offline',
				userId,
				level: 'warn',
				title: workers.length === 1 ? 'Miner offline' : 'Miners offline',
				body,
				detail: { workers },
				link: '/mining'
			});
		}
	} catch (e) {
		log.warn({ err: e }, 'offline scan failed');
	}
}

/** Test-only: reset all in-memory bridge state. */
export function __resetMiningEngineForTests(): void {
	pool = null;
	startedAt = null;
	startInFlight = null;
	if (authRefreshTimer) clearInterval(authRefreshTimer);
	if (offlineTimer) clearInterval(offlineTimer);
	authRefreshTimer = null;
	offlineTimer = null;
	fatal.length = 0;
	offlineNotified.clear();
	bestBaseline.clear();
	bestLastNotify.clear();
	netHashCache = null;
	aggregates.reset();
	aggregates.stopFlushTimer();
}
