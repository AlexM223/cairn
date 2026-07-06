// Persistence for the portfolio scan caches (cairn-er1k, part (b) of cairn-fd56).
//
// walletScan.ts / multisigScan.ts each keep a 60s in-memory scan cache. Those
// are empty on a cold restart, so the first portfolio load pays a full
// serialized Electrum re-scan of every wallet (~4.29s for 245 wallets in the
// load test). This module lets a completed scan be written to the
// `wallet_scan_cache` SQLite table (ONE upsert per scan — the load test flagged
// synchronous per-address DatabaseSync writes as the app's primary bottleneck,
// so nothing here is per-address) and read back at startup to seed the in-memory
// caches with instant-but-slightly-stale data, refreshed moments later by the
// warm pass (portfolioWarm.ts).
//
// Everything here is best-effort: a persistence hiccup must never break scanning
// or startup, so every call swallows its errors (logged at debug) and a missing
// or corrupt row simply falls back to a live scan.

import { db } from './db';
import { childLogger } from './logger';

const log = childLogger('scan-cache');

export type ScanKind = 'wallet' | 'multisig';

const upsertStmt = db.prepare(
	`INSERT INTO wallet_scan_cache (cache_key, kind, result, updated_at)
	 VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
	 ON CONFLICT(cache_key) DO UPDATE SET
	   kind = excluded.kind, result = excluded.result, updated_at = excluded.updated_at`
);

/** Write (or replace) the persisted scan result for one wallet/multisig key.
 *  One row, one write. Serialization failures are swallowed — persistence is a
 *  pure optimization and must never sink a scan. */
export function persistScanResult(kind: ScanKind, key: string, result: unknown): void {
	try {
		upsertStmt.run(key.trim(), kind, JSON.stringify(result));
	} catch (e) {
		log.debug({ err: e, kind }, 'persist scan result failed (ignored)');
	}
}

/** Drop the persisted row for one key (wallet removed / xpub changed). */
export function deletePersistedScan(key: string): void {
	try {
		db.prepare('DELETE FROM wallet_scan_cache WHERE cache_key = ?').run(key.trim());
	} catch (e) {
		log.debug({ err: e }, 'delete persisted scan failed (ignored)');
	}
}

/** Drop every persisted row of a kind (backend change / full invalidation). */
export function clearPersistedScans(kind: ScanKind): void {
	try {
		db.prepare('DELETE FROM wallet_scan_cache WHERE kind = ?').run(kind);
	} catch (e) {
		log.debug({ err: e, kind }, 'clear persisted scans failed (ignored)');
	}
}

export interface PersistedScanRow<T> {
	key: string;
	result: T;
	/** ISO 8601 timestamp of when this scan was persisted. */
	updatedAt: string;
}

/** Load all persisted rows of a kind, parsing each result JSON. Corrupt rows are
 *  skipped, not fatal. Returns [] on any read/parse failure. */
export function loadPersistedScans<T>(kind: ScanKind): PersistedScanRow<T>[] {
	try {
		const rows = db
			.prepare('SELECT cache_key, result, updated_at FROM wallet_scan_cache WHERE kind = ?')
			.all(kind) as { cache_key: string; result: string; updated_at: string }[];
		const out: PersistedScanRow<T>[] = [];
		for (const r of rows) {
			try {
				out.push({ key: r.cache_key, result: JSON.parse(r.result) as T, updatedAt: r.updated_at });
			} catch {
				// A corrupt/legacy row — skip it; the wallet just cold-scans on demand.
			}
		}
		return out;
	} catch (e) {
		log.debug({ err: e, kind }, 'load persisted scans failed (ignored)');
		return [];
	}
}
