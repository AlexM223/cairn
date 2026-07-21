// backup_missing / backup_stale detectors (cairn-evp9, docs/NOTIFICATION-PLAN.md
// Unit 8). Both event types were fully wired into the UI, preferences, activity
// feed, and icon maps but had NO trigger point — nothing ever fired them, so a
// user could enable email/Telegram for them and never be protected. This module
// is the missing detector: a lightweight daily scan (same pattern as keyHealth.ts)
// that fires them when due, each throttled so a long-lived process doesn't nag.
//
//   • backup_missing — a from-scratch wallet whose config exists nowhere else and
//     has never had a backup downloaded (per wallet_backups). Scoped to the wallet
//     OWNER. Throttled per wallet via backup_missing_notified.
//   • backup_stale   — the instance backup exists (last_instance_backup_at is set)
//     but is older than the reminder interval. Admin-scoped (userId:null fans out
//     to every admin, who are the ones who can re-download it). Throttled via a
//     settings key.
//
// Started once from hooks.server.ts, unref'd, with a short post-startup delay so a
// fresh process doesn't fire before the app has settled.

import { db } from './db';
import { notify } from './notifications';
import { getSetting, setSetting } from './settings';
import { childLogger } from './logger';

const log = childLogger('notify:backup-health');

/** How stale the instance backup gets before we remind admins to re-download. */
const INSTANCE_STALE_AFTER_MS = 30 * 86_400_000; // 30 days
/** How often we re-remind about the same still-stale/still-missing backup. */
const RENOTIFY_AFTER_MS = 30 * 86_400_000; // 30 days
/** Grace after wallet creation before nagging — the user may be mid-setup. */
const MISSING_GRACE_MS = 24 * 3_600_000; // 24 hours
const SCAN_INTERVAL_MS = 24 * 3_600_000; // daily
const STARTUP_DELAY_MS = 90_000; // let the app settle before the first scan

let started = false;

interface UnbackedRow {
	wallet_id: number;
	name: string;
	user_id: number;
}

/**
 * Fire backup_missing for from-scratch multisig wallets that still have no backup
 * and that we haven't nudged within the renotify window. Only multisigs created
 * from scratch are in scope — their config exists nowhere else (single-sig
 * reconstructs from the device, imported multisigs came from a file the user
 * already holds), matching listUnbackedWallets()'s deliberate scoping in
 * backups.ts. Best-effort — a DB error is logged, never thrown.
 */
function scanMissing(nowMs: number): void {
	const graceBefore = new Date(nowMs - MISSING_GRACE_MS).toISOString();
	const renotifyBefore = new Date(nowMs - RENOTIFY_AFTER_MS).toISOString();

	let rows: UnbackedRow[];
	try {
		rows = db
			.prepare(
				`SELECT m.id AS wallet_id, m.name AS name, m.user_id AS user_id
				   FROM multisigs m
				  WHERE m.source = 'created'
				    AND m.created_at < ?
				    AND NOT EXISTS (
				          SELECT 1 FROM wallet_backups b
				           WHERE b.wallet_kind = 'multisig' AND b.wallet_id = m.id)
				    AND NOT EXISTS (
				          SELECT 1 FROM backup_missing_notified n
				           WHERE n.wallet_kind = 'multisig' AND n.wallet_id = m.id
				             AND n.notified_at > ?)`
			)
			.all(graceBefore, renotifyBefore) as unknown as UnbackedRow[];
	} catch (e) {
		log.error({ err: e }, 'backup_missing scan query failed');
		return;
	}

	const stamp = db.prepare(
		`INSERT INTO backup_missing_notified (wallet_kind, wallet_id, notified_at)
		 VALUES ('multisig', ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
		 ON CONFLICT(wallet_kind, wallet_id)
		 DO UPDATE SET notified_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`
	);

	for (const row of rows) {
		try {
			notify({
				type: 'backup_missing',
				userId: row.user_id,
				level: 'warn',
				title: 'Back up your wallet',
				body: `Your wallet “${row.name}” has no backup yet. Its setup exists only here — download the backup so you can always recover it.`,
				detail: { walletKind: 'multisig', walletId: row.wallet_id },
				link: `/wallets/multisig/${row.wallet_id}`
			});
			stamp.run(row.wallet_id);
		} catch (e) {
			log.error({ err: e, walletId: row.wallet_id }, 'backup_missing notify failed');
		}
	}

	if (rows.length > 0) log.info({ count: rows.length }, 'backup_missing nudges fired');
}

/**
 * Fire backup_stale (admin broadcast) when the instance backup exists but is
 * older than the reminder interval, throttled by a settings key. Never fires when
 * no instance backup has ever been taken — that's an onboarding concern, not a
 * stale-backup one. Best-effort.
 */
function scanStale(nowMs: number): void {
	const last = getSetting('last_instance_backup_at');
	if (!last) return; // no backup ever taken → not "stale"
	const lastMs = Date.parse(last);
	if (Number.isNaN(lastMs)) return;
	if (nowMs - lastMs < INSTANCE_STALE_AFTER_MS) return;

	// Throttle: at most one reminder per renotify window.
	const lastNotified = getSetting('backup_stale_notified_at');
	if (lastNotified) {
		const notifiedMs = Date.parse(lastNotified);
		if (!Number.isNaN(notifiedMs) && nowMs - notifiedMs < RENOTIFY_AFTER_MS) return;
	}

	const days = Math.floor((nowMs - lastMs) / 86_400_000);
	try {
		notify({
			type: 'backup_stale',
			userId: null, // fans out to every admin — they hold the instance backup
			level: 'warn',
			title: 'Instance backup is getting old',
			body: `The last instance backup was ${days} days ago. Download a fresh encrypted backup so a recent copy exists off this server.`,
			detail: { lastBackupAt: last, ageDays: days },
			link: '/settings#node-connection'
		});
		setSetting('backup_stale_notified_at', new Date(nowMs).toISOString());
		log.info({ ageDays: days }, 'backup_stale reminder fired');
	} catch (e) {
		log.error({ err: e }, 'backup_stale notify failed');
	}
}

/** One full pass: missing-wallet nudges + instance-backup staleness. Exported for
 *  tests. Best-effort throughout. */
export function runBackupHealthScan(): void {
	const nowMs = Date.now();
	scanMissing(nowMs);
	scanStale(nowMs);
}

/** Start the daily backup-health scan. Idempotent; unref'd so it never blocks exit. */
export function startBackupHealthWatcher(): void {
	if (started) return;
	started = true;

	const first = setTimeout(() => {
		runBackupHealthScan();
	}, STARTUP_DELAY_MS);
	first.unref?.();

	const interval = setInterval(() => {
		runBackupHealthScan();
	}, SCAN_INTERVAL_MS);
	interval.unref?.();
}
