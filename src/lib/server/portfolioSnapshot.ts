// Persistence for the per-user dashboard portfolio aggregate that powers
// stale-while-revalidate (SWR) home loads.
//
// The old pattern blocked GET /api/portfolio on a LIVE Electrum scan of every
// wallet (getPortfolioDetail), guarded only by a 60s in-memory cache — so any
// dashboard visit >60s after the last one waited on real chain round-trips
// (worst case ~10s per the per-wallet timeout). Instead, the coalesced
// background refresh pass (walletSync.refreshPortfolio) computes this aggregate
// FROM the per-wallet snapshots it already produced and persists it here; the
// endpoint reads this row synchronously — zero Electrum — and NEVER scans.
//
// This is PER-USER data (each user's own wallets), so it lives in a single row
// per user_id, mirroring the single-row global `chain_snapshot`. Everything here
// is best-effort: a read/parse failure resolves to null (the page then renders
// its first-sync state), a write failure is swallowed — persistence is a pure
// optimization and must never sink a refresh.

import { db } from './db';
import { childLogger } from './logger';
import type { PortfolioDetail } from '$lib/types';

const log = childLogger('portfolio-snapshot');

export interface PortfolioSnapshotRow {
	detail: PortfolioDetail;
	/** Epoch milliseconds of the refresh pass that produced this aggregate. */
	lastSyncedAt: number;
}

// Prepared once at module load (the table is created in db.ts, which runs first
// via the `db` import above), mirroring chainSnapshot.ts.
const readStmt = db.prepare(
	'SELECT detail, last_synced_at FROM portfolio_snapshot WHERE user_id = ?'
);
const writeStmt = db.prepare(
	`INSERT INTO portfolio_snapshot (user_id, detail, last_synced_at) VALUES (?, ?, ?)
	 ON CONFLICT(user_id) DO UPDATE SET detail = excluded.detail, last_synced_at = excluded.last_synced_at`
);

/** The current persisted aggregate for a user, or null when none exists yet /
 *  it's corrupt. Synchronous and cheap — this is the only work GET does. */
export function readPortfolioSnapshot(userId: number): PortfolioSnapshotRow | null {
	try {
		const row = readStmt.get(userId) as { detail: string; last_synced_at: number } | undefined;
		if (!row) return null;
		return { detail: JSON.parse(row.detail) as PortfolioDetail, lastSyncedAt: row.last_synced_at };
	} catch (e) {
		log.debug({ err: e, userId }, 'read portfolio snapshot failed (ignored)');
		return null;
	}
}

/** Replace a user's aggregate row. One write. Serialization failures are
 *  swallowed — persistence is a pure optimization and must never sink a refresh. */
export function writePortfolioSnapshot(userId: number, detail: PortfolioDetail, at: number): void {
	try {
		writeStmt.run(userId, JSON.stringify(detail), at);
	} catch (e) {
		log.debug({ err: e, userId }, 'write portfolio snapshot failed (ignored)');
	}
}
