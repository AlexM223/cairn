// key_health_due nudges (Unit 8, docs/NOTIFICATION-PLAN.md §3).
//
// Casa-style periodic key verification: a multisig key you haven't proven you
// still control in ~180 days is a silent liability. multisig_keys.last_verified_at
// records the last proof (NULL = never); this module runs a lightweight daily
// scan for keys that have gone stale and fires ONE notify() per stale key,
// throttled to at most one nudge per key per 30 days via a guarded
// last_notified_at column (see db.ts).
//
// Started once from hooks.server.ts (same pattern as the notification queue
// worker). The interval is .unref()'d so it never keeps the process alive on
// its own, and a scan runs shortly after startup so a long-lived process doesn't
// wait a full day for the first check.

import { db } from './db';
import { notify } from './notifications';
import { childLogger } from './logger';

const log = childLogger('notify:keyhealth');

const STALE_AFTER_MS = 180 * 86_400_000; // ~6 months
const RENOTIFY_AFTER_MS = 30 * 86_400_000; // at most one nudge per key per 30 days
const SCAN_INTERVAL_MS = 24 * 3_600_000; // daily
const STARTUP_DELAY_MS = 60_000; // let the app settle before the first scan

let started = false;

interface StaleKeyRow {
	key_id: number;
	key_name: string;
	multisig_id: number;
	multisig_name: string;
	user_id: number;
	last_verified_at: string | null;
	last_notified_at: string | null;
}

/**
 * One pass: find every multisig key whose last verification is older than the
 * stale threshold (or was never verified) AND that we haven't nudged about in
 * the last 30 days, notify its owner, and stamp last_notified_at. Exported for
 * tests and for the queue worker to optionally piggyback on. Best-effort — a
 * DB error is logged, never thrown.
 */
export function runKeyHealthScan(): void {
	const nowMs = Date.now();
	const staleBefore = new Date(nowMs - STALE_AFTER_MS).toISOString();
	const renotifyBefore = new Date(nowMs - RENOTIFY_AFTER_MS).toISOString();

	let rows: StaleKeyRow[];
	try {
		rows = db
			.prepare(
				`SELECT k.id            AS key_id,
				        k.name          AS key_name,
				        k.multisig_id   AS multisig_id,
				        m.name          AS multisig_name,
				        m.user_id       AS user_id,
				        k.last_verified_at AS last_verified_at,
				        k.last_notified_at AS last_notified_at
				   FROM multisig_keys k
				   JOIN multisigs m ON m.id = k.multisig_id
				  WHERE (k.last_verified_at IS NULL OR k.last_verified_at < ?)
				    AND (k.last_notified_at IS NULL OR k.last_notified_at < ?)`
			)
			.all(staleBefore, renotifyBefore) as unknown as StaleKeyRow[];
	} catch (e) {
		log.error({ err: e }, 'key health scan query failed');
		return;
	}

	const stamp = db.prepare(
		`UPDATE multisig_keys SET last_notified_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`
	);

	for (const row of rows) {
		try {
			notify({
				type: 'key_health_due',
				userId: row.user_id,
				level: 'warn',
				title: 'A multisig key needs a health check',
				body: `The key "${row.key_name}" in your "${row.multisig_name}" wallet hasn't been verified in a while. A quick check confirms the device still holds the right key.`,
				detail: {
					keyId: row.key_id,
					multisigId: row.multisig_id,
					lastVerifiedAt: row.last_verified_at
				},
				link: `/wallets/multisig/${row.multisig_id}`
			});
			stamp.run(row.key_id);
		} catch (e) {
			log.error({ err: e, keyId: row.key_id }, 'key health notify failed');
		}
	}

	if (rows.length > 0) log.info({ count: rows.length }, 'key health nudges fired');
}

/** Start the daily key-health scan. Idempotent; unref'd so it never blocks exit. */
export function startKeyHealthWatcher(): void {
	if (started) return;
	started = true;

	const first = setTimeout(() => {
		runKeyHealthScan();
	}, STARTUP_DELAY_MS);
	first.unref?.();

	const interval = setInterval(() => {
		runKeyHealthScan();
	}, SCAN_INTERVAL_MS);
	interval.unref?.();
}
