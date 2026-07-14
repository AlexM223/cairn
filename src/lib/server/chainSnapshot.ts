// Persistence for the global chain-data snapshot that powers stale-while-
// revalidate (SWR) page loads on the dashboard + explorer pages.
//
// The old pattern re-fetched blocks/mempool/fees/difficulty from Electrum/Core RPC
// on EVERY navigation (streamed, so the page didn't blank — but the round-trips
// still happened each time). Instead, one persisted snapshot is rendered
// instantly by the page load()s (a synchronous SQLite read, zero live chain
// calls) and refreshed in the background by chainSync.ts. This is GLOBAL data
// (same for every user), so it lives in a single-row `chain_snapshot` table.
//
// Everything here is best-effort: a read/parse failure resolves to null (the
// page then shows its loading/refresh state), never a thrown error.

import { db } from './db';
import { childLogger } from './logger';
import type {
	BlockSummary,
	DifficultyAdjustment,
	DifficultyInfo,
	FeeEstimates,
	FeeHistogram,
	MempoolBlockProjection,
	MempoolSummary,
	MempoolTrendPoint
} from '$lib/types';

const log = childLogger('chain-snapshot');

/**
 * The full persisted chain dataset — every field the dashboard + explorer pages
 * render at the tip. Written atomically by refreshChainSnapshot() (chainSync.ts)
 * and read synchronously by the retrofitted page load()s. `blocks` holds the
 * newest N (currently 15, enough for both the dashboard's 10 and the explorer's
 * 15). Optional sub-fields are null when the configured backend doesn't provide
 * them, or a single sub-fetch failed.
 */
export interface PersistedChainData {
	blocks: BlockSummary[];
	tipHeight: number | null;
	tipTime: number | null;
	hashrate: number | null;
	mempoolSummary: MempoolSummary | null;
	fees: FeeEstimates | null;
	difficultyInfo: DifficultyInfo | null;
	difficultyHistory: DifficultyAdjustment[] | null;
	mempoolBlocks: MempoolBlockProjection[] | null;
	feeHistogram: FeeHistogram | null;
	mempoolTrend: MempoolTrendPoint[] | null;
}

export interface ChainSnapshotRow {
	data: PersistedChainData;
	/** Epoch milliseconds of the last successful refresh. */
	lastSyncedAt: number;
}

// Prepared once at module load (the table is created in db.ts, which runs first
// via the `db` import above), mirroring scanCachePersist.ts.
const readStmt = db.prepare('SELECT data, last_synced_at FROM chain_snapshot WHERE id = 1');
const writeStmt = db.prepare(
	`INSERT INTO chain_snapshot (id, data, last_synced_at) VALUES (1, ?, ?)
	 ON CONFLICT(id) DO UPDATE SET data = excluded.data, last_synced_at = excluded.last_synced_at`
);

/** The current persisted snapshot, or null when none exists yet / it's corrupt.
 *  Synchronous and cheap — this is the only work a retrofitted load() does. */
export function readChainSnapshot(): ChainSnapshotRow | null {
	try {
		const row = readStmt.get() as { data: string; last_synced_at: number } | undefined;
		if (!row) return null;
		return { data: JSON.parse(row.data) as PersistedChainData, lastSyncedAt: row.last_synced_at };
	} catch (e) {
		log.debug({ err: e }, 'read chain snapshot failed (ignored)');
		return null;
	}
}

/** Replace the singleton snapshot row. One write. Serialization failures are
 *  swallowed — persistence is a pure optimization and must never sink a refresh. */
export function writeChainSnapshot(data: PersistedChainData, at: number): void {
	try {
		writeStmt.run(JSON.stringify(data), at);
	} catch (e) {
		log.debug({ err: e }, 'write chain snapshot failed (ignored)');
	}
}
