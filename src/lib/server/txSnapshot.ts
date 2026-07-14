// Persistence + background refresh for the explorer transaction detail page's
// hybrid cache (single-sig-full-wallet SWR). Unlike the GLOBAL chain_snapshot
// (chainSnapshot.ts) or the per-wallet wallet_snapshots (walletSync.ts), this
// caches ONE decoded transaction per txid so the tx page can render — and make
// its RBF-redirect decision — from the last-seen data instantly, without a live
// Electrum/Core RPC getTx gating first paint. That page's getTx stayed awaited
// (it drives a 302-to-replacement vs 404 decision), so on a slow/unreachable
// backend it hung until the backend answered; this cache is the fix.
//
// Correctness: a transaction's replacement / confirmation status only moves
// FORWARD. A cached "found" tx is therefore always safe to render — at worst
// stale (confirmations behind, or the tx has since been replaced+evicted). The
// page's LIVE streamed RBF lookup still points at any replacement, so a stale
// row can never cause a WRONG redirect; the background refresh / next visit
// reconciles it. Pure performance cache: a missing/corrupt row just falls back
// to a live fetch, so it is never authoritative.

import { db } from './db';
import { getChain } from './chain';
import { childLogger } from './logger';
import type { TxDetail } from '$lib/types';

const log = childLogger('tx-snapshot');

/** Skip a background re-fetch when the cached row is younger than this — mirrors
 *  the SWR wallet/chain sync throttle so a burst of navigations to the same tx
 *  coalesces instead of hammering the backend. */
export const THROTTLE_MS = 20_000;

export interface TxSnapshotRow {
	tx: TxDetail;
	/** Epoch milliseconds of the last successful fetch. */
	cachedAt: number;
}

// Prepared once at module load (the table is created in db.ts, which runs first
// via the `db` import above), mirroring chainSnapshot.ts.
const readStmt = db.prepare('SELECT data, cached_at FROM tx_snapshots WHERE txid = ?');
const writeStmt = db.prepare(
	`INSERT INTO tx_snapshots (txid, data, cached_at) VALUES (?, ?, ?)
	 ON CONFLICT(txid) DO UPDATE SET data = excluded.data, cached_at = excluded.cached_at`
);

/** The cached decoded tx for a txid, or null when none exists yet / it's corrupt.
 *  Synchronous and cheap — this is the only work the tx page's load() does on a
 *  cache hit. Never throws. */
export function readTxSnapshot(txid: string): TxSnapshotRow | null {
	try {
		const row = readStmt.get(txid) as { data: string; cached_at: number } | undefined;
		if (!row) return null;
		return { tx: JSON.parse(row.data) as TxDetail, cachedAt: row.cached_at };
	} catch (e) {
		log.debug({ err: e, txid }, 'read tx snapshot failed (ignored)');
		return null;
	}
}

/** Upsert a txid's cached tx with a fresh cached_at. One write. Serialization /
 *  persistence failures are swallowed — caching is a pure optimization and must
 *  never sink a page render. */
export function writeTxSnapshot(txid: string, tx: TxDetail, at: number = Date.now()): void {
	try {
		writeStmt.run(txid, JSON.stringify(tx), at);
	} catch (e) {
		log.debug({ err: e, txid }, 'write tx snapshot failed (ignored)');
	}
}

/** The single shared in-flight refresh per txid, so concurrent navigations to the
 *  same tx await ONE live fetch instead of each starting their own. */
const inFlight = new Map<string, Promise<void>>();

/**
 * Fire-and-forget background refresh: re-fetch the tx and rewrite its cache row.
 * NEVER throws and NEVER overwrites a good row with an error — a failed fetch (or
 * a tx that's since been replaced+evicted, so getTx now 404s) is simply skipped,
 * leaving the last good row in place (the page's live RBF lookup handles pointing
 * at any replacement). Throttled + single-flight, exactly like the SWR wallet /
 * chain sync. Deliberately NOT awaited by the page loader.
 */
export function refreshTxSnapshot(txid: string, opts: { force?: boolean } = {}): Promise<void> {
	// Single-flight: an in-flight refresh serves every concurrent caller.
	const existing = inFlight.get(txid);
	if (existing) return existing;

	// Throttle: a fresh-enough row short-circuits the whole fetch.
	const cached = readTxSnapshot(txid);
	if (!opts.force && cached && Date.now() - cached.cachedAt < THROTTLE_MS) {
		return Promise.resolve();
	}

	// The map set/get above runs synchronously (before any await) so two callers
	// can never both start a fetch — matches singleFlightThrottled in walletSync.
	const p = (async () => {
		try {
			const tx = await getChain().getTx(txid);
			writeTxSnapshot(txid, tx);
		} catch (e) {
			log.debug({ err: e, txid }, 'tx snapshot refresh failed (kept last good row)');
		} finally {
			inFlight.delete(txid);
		}
	})();
	inFlight.set(txid, p);
	return p;
}

/** Test hook: clear the in-flight map between cases. */
export function __resetTxSnapshotForTests(): void {
	inFlight.clear();
}
