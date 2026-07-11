// Local time-series of mempool size for the explorer's 2h backlog-trend chart
// (cairn-zoz8.15). Replaces the old mempool.space /v1/statistics/2h dependency:
// there is no third-party time-series API on an Umbrel-style deploy, so instead
// the chainSync refresh cycle (chainSync.ts doRefresh, ~20s throttle) drops one
// (timestamp, vsize, txCount) sample here each pass and the trend chart reads a
// rolling window back out.
//
// Forward-looking only: the window starts EMPTY after a deploy and fills
// organically — there is no retroactive backfill — so callers/UI must render
// gracefully with sparse (or zero) data. Pure optimization/cache semantics: every
// read/write is best-effort and swallows errors (a failure just means a thinner
// chart, never a broken refresh).

import { db } from './db';
import { childLogger } from './logger';
import type { MempoolSummary, MempoolTrendPoint } from '$lib/types';

const log = childLogger('mempool-samples');

/** Keep a little more than the 2h the chart shows, so pruning can't clip it. */
const RETENTION_SECONDS = 3 * 60 * 60;

// Prepared once at module load — the table is created in db.ts, which runs first
// via the `db` import above (mirrors chainSnapshot.ts).
const insertStmt = db.prepare(
	'INSERT OR REPLACE INTO mempool_samples (at, vsize, tx_count) VALUES (?, ?, ?)'
);
const pruneStmt = db.prepare('DELETE FROM mempool_samples WHERE at < ?');
const readStmt = db.prepare(
	'SELECT at, vsize, tx_count FROM mempool_samples WHERE at >= ? ORDER BY at ASC'
);

/**
 * Persist one mempool sample (keyed by unix-second timestamp) and prune anything
 * past the retention window. Called from the background refresh cycle; never
 * throws — a persistence failure must not sink a chain refresh.
 */
export function recordMempoolSample(summary: MempoolSummary, atMs: number = Date.now()): void {
	try {
		const at = Math.floor(atMs / 1000);
		insertStmt.run(at, Math.max(0, Math.round(summary.vsize)), Math.max(0, Math.round(summary.txCount)));
		pruneStmt.run(at - RETENTION_SECONDS);
	} catch (e) {
		log.debug({ err: e }, 'record mempool sample failed (ignored)');
	}
}

/**
 * The mempool trend over the last `windowSeconds` (default 2h), oldest first.
 * Returns [] (not null) when no samples exist yet — the caller decides how to
 * present an empty/sparse series.
 */
export function readMempoolTrend(windowSeconds: number = 2 * 60 * 60): MempoolTrendPoint[] {
	try {
		const cutoff = Math.floor(Date.now() / 1000) - windowSeconds;
		const rows = readStmt.all(cutoff) as { at: number; vsize: number; tx_count: number }[];
		return rows.map((r) => ({ time: r.at, vsize: r.vsize, txCount: r.tx_count }));
	} catch (e) {
		log.debug({ err: e }, 'read mempool trend failed (ignored)');
		return [];
	}
}
