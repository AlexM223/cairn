// Stale-while-revalidate (SWR) wallet sync (cairn-2zxt).
//
// The wallet detail / list pages used to STREAM a full gap-limit Electrum scan on
// every navigation (epic cairn-vknb) — non-blocking for the shell, but still a
// fresh multi-second scan each time, which reads as "the app froze" on a busy
// Umbrel node. This module replaces that with true SWR:
//
//   • load() reads a persisted SNAPSHOT (readWalletSnapshot / readMultisigSnapshot)
//     synchronously from SQLite — zero Electrum, so navigation never blocks.
//   • The client fires refreshWalletSnapshot / refreshMultisigSnapshot in the
//     background (via the /refresh API routes). That does the real scan, rewrites
//     the snapshot row, and the client re-invalidates the loader to pick it up.
//
// Two guards keep the refresh cheap and safe under concurrency:
//   • Single-flight — a module-level Map<key, Promise> so concurrent requests /
//     tabs / a new-block nudge all await ONE in-flight scan instead of each
//     kicking off its own.
//   • Throttle — a snapshot younger than THROTTLE_MS is returned as-is without
//     re-scanning, so a burst of navigations doesn't hammer Electrum.
//
// A refresh that fails (Electrum down/slow) NEVER overwrites the last good
// snapshot and NEVER throws to the page — it rejects to the API route, which keeps
// serving the cached data with its now-stale last_synced_at. The send/PSBT flow
// deliberately does NOT read snapshots (it always re-scans live for fresh UTXOs).

import QRCode from 'qrcode';
import { db } from './db';
import { childLogger } from './logger';
import type { WalletAddress, WalletTx, WalletSummary } from '$lib/types';
import { scanWallet } from './bitcoin/walletScan';
import {
	getWallet,
	listWalletRows,
	peekReceiveAddress,
	toWalletSummary,
	type WalletRow
} from './wallets';
import {
	getWalletUtxos,
	detectWalletUnconfirmedInflows,
	type UnconfirmedInflow
} from './transactions';
import { getChain } from './chain';
import { getViewableMultisig, listMultisigs, type MultisigRow } from './wallets/multisig';
import {
	getMultisigDetail,
	peekMultisigReceiveAddress,
	toMultisigSummary,
	type MultisigScanAddress,
	type MultisigTx,
	type MultisigSummary,
	type MultisigScanResult
} from './multisigScan';
import { detectMultisigUnconfirmedInflows } from './multisigTransactions';
import { listSharedMultisigs } from './multisigShares';

const log = childLogger('wallet-sync');

/** Re-scan is skipped (cached snapshot returned as-is) when the last sync is
 *  younger than this. ~20s per the SWR design — long enough that a burst of
 *  navigations coalesces, short enough that data never feels stale. */
export const THROTTLE_MS = 20_000;

/** QR options — copied from the page loaders so a snapshot's stored QR matches
 *  what the receive panel would have rendered live (Heartwood parchment on
 *  transparent). */
const QR_OPTS = {
	margin: 1,
	width: 220,
	color: { dark: '#E4D8CC', light: '#00000000' }
};

// --------------------------------------------------------------- snapshot shapes

type CoinbaseUtxo = { txid: string; vout: number; value: number; height: number };

/** The scan-derived slice of the single-sig wallet detail page, persisted as one
 *  JSON blob. Mirrors the old streamed `WalletChainData` so the page renders
 *  identically — just instantly, from cache. `scanError` is always null in a
 *  PERSISTED snapshot (a failed scan never overwrites the last good one); it
 *  stays in the shape so the page's degraded-state branch keeps type-checking. */
export interface WalletSnapshot {
	scan: {
		addresses: WalletAddress[];
		txs: WalletTx[];
		confirmed: number;
		unconfirmed: number;
	} | null;
	receive: { address: string; path: string; index: number; qr: string } | null;
	coinbaseUtxos: CoinbaseUtxo[];
	tipHeight: number;
	speedUp: UnconfirmedInflow[];
	scanError: string | null;
}

/** The scan-derived slice of the multisig detail page. `savedTxs` is NOT stored
 *  here — it's a cheap local (and viewer-scoped) DB read the loader adds fresh. */
export interface MultisigSnapshot {
	detail: {
		balance: { confirmed: number; unconfirmed: number };
		addresses: MultisigScanAddress[];
		history: MultisigTx[];
		utxoCount: number;
	} | null;
	receive: { address: string; index: number; qr: string } | null;
	coinbaseUtxos: CoinbaseUtxo[];
	tipHeight: number;
	speedUp: UnconfirmedInflow[];
	scanError: string | null;
}

/** An empty (never-synced) single-sig snapshot — what the loader returns before
 *  the first background refresh completes. */
export const EMPTY_WALLET_SNAPSHOT: WalletSnapshot = {
	scan: null,
	receive: null,
	coinbaseUtxos: [],
	tipHeight: 0,
	speedUp: [],
	scanError: null
};

/** An empty (never-synced) multisig snapshot. */
export const EMPTY_MULTISIG_SNAPSHOT: MultisigSnapshot = {
	detail: null,
	receive: null,
	coinbaseUtxos: [],
	tipHeight: 0,
	speedUp: [],
	scanError: null
};

type SnapshotKind = 'wallet' | 'multisig';

export interface StoredSnapshot<T> {
	snapshot: T;
	/** ms epoch of the scan that produced this snapshot. */
	lastSyncedAt: number;
}

// --------------------------------------------------------------- persistence

const upsertStmt = db.prepare(
	`INSERT INTO wallet_snapshots (wallet_kind, wallet_id, snapshot, last_synced_at)
	 VALUES (?, ?, ?, ?)
	 ON CONFLICT(wallet_kind, wallet_id) DO UPDATE SET
	   snapshot = excluded.snapshot, last_synced_at = excluded.last_synced_at`
);

/** Persist (or replace) a wallet's snapshot with a fresh last_synced_at. One row,
 *  one write. Best-effort — a persistence hiccup must never sink a scan. Returns
 *  the timestamp written so callers can report it without a re-read. */
function writeSnapshot(kind: SnapshotKind, id: number, snapshot: unknown): number {
	const now = Date.now();
	try {
		upsertStmt.run(kind, id, JSON.stringify(snapshot), now);
	} catch (e) {
		log.debug({ err: e, kind, id }, 'persist wallet snapshot failed (ignored)');
	}
	return now;
}

const readStmt = db.prepare(
	'SELECT snapshot, last_synced_at FROM wallet_snapshots WHERE wallet_kind = ? AND wallet_id = ?'
);

/** Read + parse a stored snapshot, or null when absent/corrupt. Never throws. */
function readSnapshot<T>(kind: SnapshotKind, id: number): StoredSnapshot<T> | null {
	try {
		const row = readStmt.get(kind, id) as
			| { snapshot: string; last_synced_at: number }
			| undefined;
		if (!row) return null;
		return { snapshot: JSON.parse(row.snapshot) as T, lastSyncedAt: row.last_synced_at };
	} catch (e) {
		log.debug({ err: e, kind, id }, 'read wallet snapshot failed (ignored)');
		return null;
	}
}

/** The persisted single-sig snapshot for a wallet, or null when never synced. */
export function readWalletSnapshot(walletId: number): StoredSnapshot<WalletSnapshot> | null {
	return readSnapshot<WalletSnapshot>('wallet', walletId);
}

/** The persisted multisig snapshot, or null when never synced. */
export function readMultisigSnapshot(multisigId: number): StoredSnapshot<MultisigSnapshot> | null {
	return readSnapshot<MultisigSnapshot>('multisig', multisigId);
}

// ------------------------------------------------- single-flight + throttle core

/**
 * The shared single-flight + throttle engine. Exported for direct testing.
 *
 * Returns the CACHED value without calling `doScan` when a snapshot exists and is
 * younger than `throttleMs`. Otherwise, if a scan for this key is already in
 * flight, returns that same promise (single-flight); if not, starts one, records
 * it in `map`, and clears it when settled. Deliberately NOT an `async` function:
 * the map get/set must run synchronously (before any await) so two concurrent
 * callers can never both start a scan.
 */
export function singleFlightThrottled<T>(
	map: Map<string, Promise<T>>,
	key: string,
	opts: {
		force?: boolean;
		throttleMs?: number;
		/** last_synced_at of the currently persisted snapshot, or null if none. */
		lastSyncedAt: number | null;
		/** Return the persisted snapshot — only called on a throttle hit. */
		readCached: () => T;
		/** The real (expensive) scan + persist. */
		doScan: () => Promise<T>;
		/** Injectable clock for tests. */
		now?: () => number;
	}
): Promise<T> {
	const now = opts.now ?? Date.now;
	const throttleMs = opts.throttleMs ?? THROTTLE_MS;

	if (!opts.force && opts.lastSyncedAt !== null && now() - opts.lastSyncedAt < throttleMs) {
		return Promise.resolve(opts.readCached());
	}

	const inflight = map.get(key);
	if (inflight) return inflight;

	const p = (async () => {
		try {
			return await opts.doScan();
		} finally {
			map.delete(key);
		}
	})();
	map.set(key, p);
	return p;
}

const inFlightWallet = new Map<string, Promise<WalletSnapshot>>();
const inFlightMultisig = new Map<string, Promise<MultisigSnapshot>>();

// -------------------------------------------------------------- single-sig scan

/** The real single-sig scan. Throws when the core wallet scan is unreachable —
 *  so a failure rejects to the API route (which keeps serving cached data)
 *  rather than persisting an error snapshot over the last good one. */
async function doWalletScan(userId: number, row: WalletRow): Promise<WalletSnapshot> {
	// Core scan first — this is the one that must succeed to have anything worth
	// persisting. A failure here throws (see above).
	const scan = await scanWallet(row.xpub);
	const receive = await peekReceiveAddress(row);
	const qr = await QRCode.toDataURL(receive.address, QR_OPTS);

	// Mining-reward (coinbase) UTXOs + chain tip — tolerate a hiccup; the balance
	// and receive card are what matter. Empty for almost every wallet.
	let coinbaseUtxos: CoinbaseUtxo[] = [];
	let tipHeight = 0;
	try {
		const [utxos, tip] = await Promise.all([getWalletUtxos(row.xpub), getChain().getTip()]);
		tipHeight = tip.height;
		coinbaseUtxos = utxos
			.filter((u) => u.coinbase)
			.map((u) => ({ txid: u.txid, vout: u.vout, value: u.value, height: u.height }));
	} catch {
		coinbaseUtxos = [];
		tipHeight = 0;
	}

	// Which unconfirmed txs can be sped up (RBF vs CPFP). Tolerate a hiccup — the
	// button just doesn't appear.
	let speedUp: UnconfirmedInflow[] = [];
	try {
		speedUp = (await detectWalletUnconfirmedInflows(userId, row.id)) ?? [];
	} catch {
		speedUp = [];
	}

	const snapshot: WalletSnapshot = {
		scan: {
			addresses: scan.addresses,
			txs: scan.txs,
			confirmed: scan.confirmed,
			unconfirmed: scan.unconfirmed
		},
		receive: { ...receive, qr },
		coinbaseUtxos,
		tipHeight,
		speedUp,
		scanError: null
	};
	writeSnapshot('wallet', row.id, snapshot);
	return snapshot;
}

/**
 * Refresh (or return the throttled cache of) a single-sig wallet's snapshot.
 * Returns null when the wallet doesn't exist or isn't owned by userId. Rejects
 * when the live scan fails — the caller keeps serving the last good snapshot.
 */
export function refreshWalletSnapshot(
	userId: number,
	walletId: number,
	opts: { force?: boolean } = {}
): Promise<WalletSnapshot | null> {
	const row = getWallet(userId, walletId);
	if (!row) return Promise.resolve(null);
	const cached = readWalletSnapshot(walletId);
	return singleFlightThrottled(inFlightWallet, `wallet:${walletId}`, {
		force: opts.force,
		lastSyncedAt: cached?.lastSyncedAt ?? null,
		readCached: () => cached!.snapshot,
		doScan: () => doWalletScan(userId, row)
	});
}

// ---------------------------------------------------------------- multisig scan

/** The real multisig scan. Throws when the core detail scan is unreachable. */
async function doMultisigScan(userId: number, multisig: MultisigRow): Promise<MultisigSnapshot> {
	const detail = await getMultisigDetail(multisig);
	const receive = await peekMultisigReceiveAddress(multisig);
	const qr = await QRCode.toDataURL(receive.address, QR_OPTS);

	let coinbaseUtxos: CoinbaseUtxo[] = [];
	let tipHeight = 0;
	try {
		// getMultisigDetail already ran the scan, so getMultisigUtxos hits the cache;
		// guard the tip separately so a tip hiccup just hides the coinbase section.
		const tip = await getChain().getTip();
		tipHeight = tip.height;
		coinbaseUtxos = detail.utxos
			.filter((u) => u.coinbase)
			.map((u) => ({ txid: u.txid, vout: u.vout, value: u.value, height: u.height }));
	} catch {
		coinbaseUtxos = [];
		tipHeight = 0;
	}

	let speedUp: UnconfirmedInflow[] = [];
	try {
		speedUp = (await detectMultisigUnconfirmedInflows(userId, multisig.id)) ?? [];
	} catch {
		speedUp = [];
	}

	const snapshot: MultisigSnapshot = {
		detail: {
			balance: detail.balance,
			addresses: detail.addresses,
			history: detail.history,
			utxoCount: detail.utxos.length
		},
		receive: { ...receive, qr },
		coinbaseUtxos,
		tipHeight,
		speedUp,
		scanError: null
	};
	writeSnapshot('multisig', multisig.id, snapshot);
	return snapshot;
}

/**
 * Refresh (or return the throttled cache of) a multisig's snapshot. Any
 * participant (owner / viewer / cosigner) may trigger it — the snapshot is the
 * same for all of them (it's derived from the wallet's coins, not the caller).
 * Returns null when the multisig isn't visible to userId.
 */
export function refreshMultisigSnapshot(
	userId: number,
	multisigId: number,
	opts: { force?: boolean } = {}
): Promise<MultisigSnapshot | null> {
	const multisig = getViewableMultisig(userId, multisigId);
	if (!multisig) return Promise.resolve(null);
	const cached = readMultisigSnapshot(multisigId);
	return singleFlightThrottled(inFlightMultisig, `multisig:${multisigId}`, {
		force: opts.force,
		lastSyncedAt: cached?.lastSyncedAt ?? null,
		readCached: () => cached!.snapshot,
		doScan: () => doMultisigScan(userId, multisig)
	});
}

// ----------------------------------------------------------- cached list summaries

/** A MultisigScanResult reconstructed from a stored snapshot's detail slice, so
 *  the existing toMultisigSummary can derive balance/lastActivity without a scan. */
function scanResultFromMultisigSnapshot(snap: MultisigSnapshot): MultisigScanResult | undefined {
	if (!snap.detail) return undefined;
	return {
		addresses: snap.detail.addresses,
		txs: snap.detail.history,
		confirmed: snap.detail.balance.confirmed,
		unconfirmed: snap.detail.balance.unconfirmed
	};
}

/**
 * The wallets-list payload, built SYNCHRONOUSLY from persisted snapshots — zero
 * Electrum, so the list page never blocks on navigation. A wallet with no
 * snapshot yet simply shows zeroed balances until the background refresh fills it
 * in (it is NOT flagged unreachable — that's reserved for an actual scan error,
 * which the cache-first path never produces). `lastSyncedAt` is the OLDEST sync
 * across all wallets (the freshness the aggregate indicator should honour), or
 * null when nothing has synced yet.
 */
export function listCachedPortfolio(userId: number): {
	wallets: WalletSummary[];
	errors: Record<number, string>;
	multisigs: MultisigSummary[];
	multisigErrors: Record<number, string>;
	lastSyncedAt: number | null;
} {
	let oldest: number | null = null;
	const note = (ts: number | null) => {
		if (ts === null) return;
		oldest = oldest === null ? ts : Math.min(oldest, ts);
	};

	const wallets = listWalletRows(userId).map((row) => {
		const cached = readWalletSnapshot(row.id);
		note(cached?.lastSyncedAt ?? null);
		return toWalletSummary(row, cached?.snapshot.scan ?? undefined);
	});

	const multisigs: MultisigSummary[] = [];
	for (const row of listMultisigs(userId)) {
		const cached = readMultisigSnapshot(row.id);
		note(cached?.lastSyncedAt ?? null);
		multisigs.push(
			toMultisigSummary(row, cached ? scanResultFromMultisigSnapshot(cached.snapshot) : undefined)
		);
	}
	// Multisigs shared WITH this user render exactly like owned ones, tagged with
	// the share role + owner name.
	for (const s of listSharedMultisigs(userId)) {
		const row = getViewableMultisig(userId, s.multisigId);
		if (!row) continue;
		const cached = readMultisigSnapshot(row.id);
		note(cached?.lastSyncedAt ?? null);
		multisigs.push(
			toMultisigSummary(row, cached ? scanResultFromMultisigSnapshot(cached.snapshot) : undefined, {
				role: s.role,
				sharedBy: s.ownerName
			})
		);
	}

	return { wallets, errors: {}, multisigs, multisigErrors: {}, lastSyncedAt: oldest };
}
