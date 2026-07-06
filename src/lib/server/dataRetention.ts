// Daily data-retention sweep (cairn-zui7) — the one place unbounded or orphaned
// tables get purged. The 2026-07-06 data audit's top structural finding was that
// nothing in the codebase ever deletes aged rows (balance_snapshots,
// notification_queue, expired sessions, ...); this module is the shared scaffold
// those purge steps register into.
//
// Shape mirrors the other background jobs (addressWatcher.ts et al.): started
// once from hooks.server.ts, idempotent, every timer unref'd so it never holds
// the process open, and strictly best-effort — a step throwing is logged and
// skipped, never rethrown, and never blocks the remaining steps (same
// fault-isolation stance as notificationQueue's drain loop).
//
// Cadence: once shortly after startup (a long-lived instance shouldn't wait a
// day for its first sweep — and short-lived dev instances still get coverage),
// then every 24h.

import { db } from './db';
import { childLogger } from './logger';

const log = childLogger('retention');

/** Run the first sweep this long after boot — after the app has settled. */
const STARTUP_DELAY_MS = 30_000;
const SWEEP_INTERVAL_MS = 24 * 60 * 60_000;

/** One named, independently fault-isolated purge. */
export interface RetentionStep {
	/** Short identifier for logs (e.g. 'balance_snapshots'). */
	name: string;
	/** Do the purge. May be sync or async; a throw/rejection is contained. */
	run: () => void | Promise<void>;
}

/** ISO-8601 UTC timestamp `days` days before now — the shape every timestamp
 *  column in this schema stores, so plain string comparison works in SQL. */
function isoDaysAgo(days: number): string {
	return new Date(Date.now() - days * 24 * 60 * 60_000).toISOString();
}

// ---------------------------------------------------------------------------
// balance_snapshots (cairn-zui7.2) — one row per (user, wallet, hour) forever,
// the schema's clearest will-grow-forever table. Two-part policy:
//   • hourly resolution is only needed for recent charts: rows older than 30
//     days are DOWNSAMPLED to the first tick of each day (per wallet). Keeping
//     whole ticks preserves getBalanceSeries' GROUP BY taken_at sums.
//   • rows older than 13 months are dropped outright (comfortably covers any
//     >1-year chart view at daily resolution).
//   • rows for wallets/multisigs that no longer exist are orphans — nothing
//     removes them on wallet delete — and are dropped at any age.
// ---------------------------------------------------------------------------
export function purgeBalanceSnapshots(): void {
	const hourlyCutoff = isoDaysAgo(30);
	const hardCutoff = isoDaysAgo(396); // ~13 months

	db.prepare('DELETE FROM balance_snapshots WHERE taken_at < ?').run(hardCutoff);

	// Downsample: among rows older than the hourly window, keep only each
	// wallet's first row per UTC day (date() understands our ISO strings).
	db.prepare(
		`DELETE FROM balance_snapshots
		  WHERE taken_at < ?
		    AND id NOT IN (
		      SELECT MIN(id) FROM balance_snapshots
		       WHERE taken_at < ?
		       GROUP BY user_id, wallet_kind, wallet_id, date(taken_at)
		    )`
	).run(hourlyCutoff, hourlyCutoff);

	db.prepare(
		`DELETE FROM balance_snapshots
		  WHERE (wallet_kind = 'wallet' AND wallet_id NOT IN (SELECT id FROM wallets))
		     OR (wallet_kind = 'multisig' AND wallet_id NOT IN (SELECT id FROM multisigs))`
	).run();
}

// ---------------------------------------------------------------------------
// notification_queue (cairn-zui7.3) — despite the schema comment, nothing ever
// removed sent/dead rows. Terminal rows older than 30 days go; anything still
// in flight ('pending'/'failed' awaiting retry) is never touched. 'dead' rows
// have no delivery timestamp, so their last scheduling time (next_attempt_at,
// falling back to created_at) stands in for the last attempt.
// ---------------------------------------------------------------------------
export function purgeNotificationQueue(): void {
	const cutoff = isoDaysAgo(30);
	db.prepare(
		`DELETE FROM notification_queue
		  WHERE (status = 'sent' AND COALESCE(sent_at, created_at) < ?)
		     OR (status = 'dead' AND COALESCE(next_attempt_at, created_at) < ?)`
	).run(cutoff, cutoff);
}

// ---------------------------------------------------------------------------
// sessions + recovery_grants (cairn-zui7.4) — both tables only reap an expired
// row lazily when that exact token is presented again, so abandoned rows (with
// sessions carrying raw ip_address/user_agent) sit forever. Sweep everything
// past its own expires_at; live rows are never touched.
// ---------------------------------------------------------------------------
export function purgeExpiredAuthRows(): void {
	const now = new Date().toISOString();
	db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now);
	db.prepare('DELETE FROM recovery_grants WHERE expires_at < ?').run(now);
}

// ---------------------------------------------------------------------------
// known_devices (cairn-zui7.5) — one (user, UA-hash) row per device forever,
// written for new-device detection and never read back anywhere else. A device
// not seen in 12 months is stale for that purpose (its next sign-in just reads
// as a new device again) — no reason to retain the user_agent indefinitely.
// ---------------------------------------------------------------------------
export function purgeStaleKnownDevices(): void {
	db.prepare('DELETE FROM known_devices WHERE last_seen < ?').run(isoDaysAgo(365));
}

// The registered purge steps, run in order.
const STEPS: RetentionStep[] = [
	{ name: 'balance_snapshots', run: purgeBalanceSnapshots },
	{ name: 'notification_queue', run: purgeNotificationQueue },
	{ name: 'expired_auth_rows', run: purgeExpiredAuthRows },
	{ name: 'known_devices', run: purgeStaleKnownDevices }
];

/** Outcome of one step in a sweep — surfaced for tests and log summaries. */
export interface StepResult {
	name: string;
	ok: boolean;
}

/**
 * Run every registered step in sequence. A step that throws or rejects is
 * logged and marked failed; the remaining steps still run. Exported (with an
 * injectable step list) so tests can drive the dispatcher directly.
 */
export async function runRetentionSweep(steps: RetentionStep[] = STEPS): Promise<StepResult[]> {
	const results: StepResult[] = [];
	for (const step of steps) {
		try {
			await step.run();
			results.push({ name: step.name, ok: true });
		} catch (e) {
			log.error({ err: e, step: step.name }, 'retention step failed — continuing with the rest');
			results.push({ name: step.name, ok: false });
		}
	}
	if (results.length > 0) {
		log.info(
			{ steps: results.length, failed: results.filter((r) => !r.ok).map((r) => r.name) },
			'retention sweep finished'
		);
	}
	return results;
}

let started = false;

/**
 * Start the daily retention sweep. Idempotent; never throws into the caller
 * (hooks.server.ts wraps it in try/catch too, like the other watchers).
 */
export function startRetentionSweep(): void {
	if (started) return;
	started = true;

	const first = setTimeout(() => {
		void runRetentionSweep().catch((e) => log.error({ err: e }, 'startup retention sweep failed'));
	}, STARTUP_DELAY_MS);
	first.unref?.();

	const daily = setInterval(() => {
		void runRetentionSweep().catch((e) => log.error({ err: e }, 'daily retention sweep failed'));
	}, SWEEP_INTERVAL_MS);
	daily.unref?.();
}
