/**
 * Read models for the mining UI (cairn-vn43.22/.23). Two functions produce the
 * EXACT JSON contracts the /mining (user) and /admin/mining (admin) pages +
 * their poll endpoints consume. Live "now" values come from the in-memory
 * aggregates (fresh to the last share); durable history (blocks, the admin
 * hashrate series, all-time best) comes from the DB mirror.
 *
 * STRICT per-user scoping: getUserMiningView(userId) only ever reads that user's
 * prefs, workers, wallets, and blocks — a user must never see another user's
 * hashrate, earnings, or workers (security test in readModels.test.ts).
 */
import { db } from '../db';
import { getWallet, listWalletRows, peekReceiveAddress } from '../wallets';
import { readMiningSettings, type MiningBind } from './settings';
import { getMiningPrefs } from './prefs';
import {
	getMiningAggregates,
	miningEngineStatus,
	miningFatalErrors,
	getNetworkHashps
} from './index';
import { getChain } from '../chain';
import { coinbaseMaturity } from '$lib/shared/coinbase';
import { soloOdds } from '$lib/shared/hashrate';
import { childLogger } from '../logger';

const log = childLogger('mining:readmodels');

type EngineDisplayStatus = 'running' | 'stopped' | 'core_missing';

// --------------------------------------------------------------- user view

export interface UserMiningView {
	engine: { status: EngineDisplayStatus; stratumPort: number; bind: MiningBind };
	connection: { miningId: string; workerFormat: string; password: 'x' } | null;
	payout: { walletId: number; walletName: string; address: string } | null;
	workers: {
		name: string;
		online: boolean;
		lastShareAgoSec: number | null;
		hashrate: { now: number; h1: number; h24: number };
		shares: { accepted: number; stale: number; rejected: number };
		bestShareDifficulty: number;
	}[];
	totals: {
		hashrateNow: number;
		hashrate24h: number;
		bestShareEver: number;
		acceptedShares: number;
		staleShares: number;
	};
	earnings: {
		blocksFound: {
			height: number;
			txid: string | null;
			vout: 0;
			reward: number;
			foundAt: string;
			status: 'maturing' | 'mature' | 'rejected';
		}[];
		totalMaturedSats: number;
		totalPendingSats: number;
	};
	odds: {
		userHashrate: number;
		networkHashps: number;
		expectedYearsPerBlock: number;
		probPerDayPct: number;
	} | null;
	wallets: { id: number; name: string; eligible: boolean }[];
}

const ONLINE_THRESHOLD_MS = 5 * 60_000;

function engineDisplayStatus(): EngineDisplayStatus {
	const s = miningEngineStatus();
	if (s.running) return 'running';
	if (s.coreRpc === 'unconfigured') return 'core_missing';
	return 'stopped';
}

async function safeTipHeight(): Promise<number> {
	try {
		return (await getChain().getTip()).height;
	} catch (e) {
		log.warn({ err: e }, 'tip fetch failed; treating coinbases as unconfirmed');
		return 0;
	}
}

/** DB stored all-time best share difficulty for a user. */
function storedBest(userId: number): number {
	try {
		const row = db
			.prepare('SELECT MAX(best_share_diff) AS best FROM mining_workers WHERE user_id = ?')
			.get(userId) as { best: number | null } | undefined;
		return row?.best ?? 0;
	} catch {
		return 0;
	}
}

interface BlockRow {
	height: number;
	block_hash: string;
	coinbase_txid: string | null;
	user_id: number | null;
	worker_name: string | null;
	wallet_id: number | null;
	payout_address: string;
	coinbase_value_sats: string;
	found_at: string;
	submit_result: string;
}

function blockStatus(row: BlockRow, tipHeight: number): 'maturing' | 'mature' | 'rejected' {
	if (row.submit_result.startsWith('rejected')) return 'rejected';
	return coinbaseMaturity(row.height, tipHeight).mature ? 'mature' : 'maturing';
}

export async function getUserMiningView(userId: number): Promise<UserMiningView> {
	const settings = readMiningSettings();
	const prefs = getMiningPrefs(userId);
	const agg = getMiningAggregates();
	const now = Date.now();
	const tipHeight = await safeTipHeight();

	// connection
	let connection: UserMiningView['connection'] = null;
	if (prefs?.miningId) {
		connection = {
			miningId: prefs.miningId,
			workerFormat: `${prefs.miningId}.<workerName>`,
			password: 'x'
		};
	}

	// payout
	let payout: UserMiningView['payout'] = null;
	if (prefs?.payoutWalletId != null) {
		const wallet = getWallet(userId, prefs.payoutWalletId);
		if (wallet) {
			try {
				const peek = await peekReceiveAddress(wallet);
				payout = { walletId: wallet.id, walletName: wallet.name, address: peek.address };
			} catch (e) {
				log.warn({ err: e, userId, walletId: wallet.id }, 'payout address peek failed');
				payout = { walletId: wallet.id, walletName: wallet.name, address: '' };
			}
		}
	}

	// workers + totals (live, session-scoped)
	const live = agg.liveWorkers(userId);
	const workers = live.map((w) => {
		const online = w.lastShareAtMs !== null && now - w.lastShareAtMs < ONLINE_THRESHOLD_MS;
		return {
			name: w.worker,
			online,
			lastShareAgoSec: w.lastShareAtMs === null ? null : Math.round((now - w.lastShareAtMs) / 1000),
			hashrate: w.hashrate,
			shares: { accepted: w.sharesAccepted, stale: w.sharesStale, rejected: w.sharesRejected },
			bestShareDifficulty: w.bestShareDiff
		};
	});
	const totals = {
		hashrateNow: live.reduce((a, w) => a + w.hashrate.now, 0),
		hashrate24h: live.reduce((a, w) => a + w.hashrate.h24, 0),
		bestShareEver: Math.max(storedBest(userId), agg.sessionBest(userId)),
		acceptedShares: live.reduce((a, w) => a + w.sharesAccepted, 0),
		staleShares: live.reduce((a, w) => a + w.sharesStale, 0)
	};

	// earnings
	const blockRows = db
		.prepare('SELECT * FROM mining_blocks WHERE user_id = ? ORDER BY height DESC, id DESC')
		.all(userId) as unknown as BlockRow[];
	let totalMaturedSats = 0;
	let totalPendingSats = 0;
	const blocksFound = blockRows.map((row) => {
		const status = blockStatus(row, tipHeight);
		const reward = Number(row.coinbase_value_sats);
		if (status === 'mature') totalMaturedSats += reward;
		else if (status === 'maturing') totalPendingSats += reward;
		return {
			height: row.height,
			txid: row.coinbase_txid,
			vout: 0 as const,
			reward,
			foundAt: row.found_at,
			status
		};
	});

	// odds
	const networkHashps = await getNetworkHashps();
	let odds: UserMiningView['odds'] = null;
	if (networkHashps !== null && totals.hashrateNow > 0) {
		const o = soloOdds(totals.hashrateNow, networkHashps);
		if (o) {
			odds = {
				userHashrate: totals.hashrateNow,
				networkHashps,
				expectedYearsPerBlock: o.expectedYearsPerBlock,
				probPerDayPct: o.probPerDayPct
			};
		}
	}

	// wallets (all the user's xpub wallets are payout-eligible)
	const wallets = listWalletRows(userId).map((w) => ({
		id: w.id,
		name: w.name,
		eligible: !!w.xpub && w.xpub.trim() !== ''
	}));

	return {
		engine: { status: engineDisplayStatus(), stratumPort: settings.stratumPort, bind: settings.bind },
		connection,
		payout,
		workers,
		totals,
		earnings: { blocksFound, totalMaturedSats, totalPendingSats },
		odds,
		wallets
	};
}

// --------------------------------------------------------------- admin view

export interface AdminMiningView {
	engine: {
		status: EngineDisplayStatus;
		coreRpc: 'ok' | 'down' | 'unconfigured';
		uptimeSec: number;
		bind: MiningBind;
		stratumPort: number;
		lastTemplateAgoSec: number | null;
		fatalErrors: string[];
	};
	pool: { connectedWorkers: number; connectedUsers: number; hashrateNow: number; hashrate24h: number };
	hashrateSeries: { t: number; hashrate: number }[];
	miners: {
		userId: number;
		userName: string;
		worker: string;
		hashrate: number;
		difficulty: number;
		lastShareAgoSec: number | null;
		online: boolean;
	}[];
	userBreakdown: {
		userId: number;
		userName: string;
		workers: number;
		hashrate: number;
		sharePct: number;
	}[];
	blocks: {
		height: number;
		blockHash: string;
		foundByName: string;
		reward: number;
		foundAt: string;
		confirmations: number;
		status: 'maturing' | 'mature' | 'rejected';
	}[];
	settings: {
		enabled: boolean;
		bind: MiningBind;
		port: number;
		shareDifficulty: number;
		vardiffEnabled: boolean;
		vardiffTargetPerMin: number;
		poolTag: string;
	};
}

/** Resolve a set of user ids to display names in one query. */
function userNames(ids: number[]): Map<number, string> {
	const out = new Map<number, string>();
	const unique = [...new Set(ids)].filter((id) => Number.isInteger(id));
	if (unique.length === 0) return out;
	const placeholders = unique.map(() => '?').join(',');
	try {
		const rows = db
			.prepare(`SELECT id, display_name, email FROM users WHERE id IN (${placeholders})`)
			.all(...unique) as { id: number; display_name: string | null; email: string }[];
		for (const r of rows) out.set(r.id, r.display_name?.trim() || r.email);
	} catch (e) {
		log.warn({ err: e }, 'userNames lookup failed');
	}
	return out;
}

export async function getAdminMiningView(): Promise<AdminMiningView> {
	const settings = readMiningSettings();
	const status = miningEngineStatus();
	const agg = getMiningAggregates();
	const now = Date.now();
	const tipHeight = await safeTipHeight();

	const engineStatus = engineDisplayStatus();
	const lastJobAt = status.engine?.lastJobAt ?? null;

	// live miners + names
	const liveMiners = agg.liveAllMiners();
	const names = userNames([
		...liveMiners.map((m) => m.userId),
		...(db.prepare('SELECT DISTINCT user_id FROM mining_blocks WHERE user_id IS NOT NULL').all() as {
			user_id: number;
		}[]).map((r) => r.user_id)
	]);

	const miners = liveMiners.map((m) => ({
		userId: m.userId,
		userName: names.get(m.userId) ?? `user ${m.userId}`,
		worker: m.worker,
		hashrate: m.hashrate.now,
		difficulty: m.currentDiff,
		lastShareAgoSec: m.lastShareAtMs === null ? null : Math.round((now - m.lastShareAtMs) / 1000),
		online: m.lastShareAtMs !== null && now - m.lastShareAtMs < ONLINE_THRESHOLD_MS
	}));

	const poolHashrateNow = liveMiners.reduce((a, m) => a + m.hashrate.now, 0);
	const poolHashrate24h = liveMiners.reduce((a, m) => a + m.hashrate.h24, 0);

	// userBreakdown
	const byUser = new Map<number, { workers: number; hashrate: number }>();
	for (const m of liveMiners) {
		const cur = byUser.get(m.userId) ?? { workers: 0, hashrate: 0 };
		cur.workers += 1;
		cur.hashrate += m.hashrate.now;
		byUser.set(m.userId, cur);
	}
	const userBreakdown = [...byUser.entries()].map(([userId, v]) => ({
		userId,
		userName: names.get(userId) ?? `user ${userId}`,
		workers: v.workers,
		hashrate: v.hashrate,
		sharePct: poolHashrateNow > 0 ? (v.hashrate / poolHashrateNow) * 100 : 0
	}));

	// connectedUsers = distinct users with a live Stratum connection
	const connections = status.engine?.connections ?? [];
	const connectedUsers = new Set(connections.map((c) => c.userId)).size;

	// hashrate series (pool rows, last 24h)
	const sinceIso = new Date(now - 86_400_000).toISOString();
	let hashrateSeries: { t: number; hashrate: number }[] = [];
	try {
		const rows = db
			.prepare(
				`SELECT bucket_start, hashrate_est
				   FROM mining_stats
				  WHERE user_id IS NULL AND bucket_start >= ?
				  ORDER BY bucket_start ASC`
			)
			.all(sinceIso) as { bucket_start: string; hashrate_est: number }[];
		hashrateSeries = rows.map((r) => ({ t: Date.parse(r.bucket_start), hashrate: r.hashrate_est }));
	} catch (e) {
		log.warn({ err: e }, 'hashrate series read failed');
	}

	// blocks (all users, newest first)
	const blockRows = db
		.prepare('SELECT * FROM mining_blocks ORDER BY height DESC, id DESC LIMIT 100')
		.all() as unknown as BlockRow[];
	const blocks = blockRows.map((row) => ({
		height: row.height,
		blockHash: row.block_hash,
		foundByName: row.user_id === null ? '—' : (names.get(row.user_id) ?? `user ${row.user_id}`),
		reward: Number(row.coinbase_value_sats),
		foundAt: row.found_at,
		confirmations: coinbaseMaturity(row.height, tipHeight).confirmations,
		status: blockStatus(row, tipHeight)
	}));

	return {
		engine: {
			status: engineStatus,
			coreRpc: status.coreRpc,
			uptimeSec: status.startedAt === null ? 0 : Math.round((now - status.startedAt) / 1000),
			bind: settings.bind,
			stratumPort: settings.stratumPort,
			lastTemplateAgoSec: lastJobAt === null ? null : Math.round((now - lastJobAt) / 1000),
			fatalErrors: miningFatalErrors()
		},
		pool: {
			connectedWorkers: connections.length,
			connectedUsers,
			hashrateNow: poolHashrateNow,
			hashrate24h: poolHashrate24h
		},
		hashrateSeries,
		miners,
		userBreakdown,
		blocks,
		settings: {
			enabled: settings.enabled,
			bind: settings.bind,
			port: settings.stratumPort,
			shareDifficulty: settings.shareDifficulty,
			vardiffEnabled: settings.vardiffEnabled,
			vardiffTargetPerMin: settings.vardiffTargetPerMin,
			poolTag: settings.poolTag
		}
	};
}
