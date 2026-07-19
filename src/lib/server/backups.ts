// Wallet-config backup status, tracked server-side. A wallet's configuration —
// its public keys and settings — is what's needed to find its bitcoin and, for
// multisig, to RECONSTRUCT the wallet at all; losing it (with Cairn's data
// gone) can mean permanently losing access to funds. So we treat "has the user
// downloaded this wallet's backup?" as first-class state, not a client-only
// flag. See db.ts (wallet_backups) and the creation wizards / persistent banner.

import { db } from './db';
import { recordActivity } from './activity';
import { childLogger } from './logger';
import type { WalletKind } from '$lib/types';

const log = childLogger('backups:nudge');

/** A wallet that still has no config backup on record. */
export interface UnbackedWallet {
	kind: WalletKind;
	id: number;
	name: string;
	/** Link to this wallet's detail page (where its backup can be downloaded). */
	href: string;
}

/** Record that a wallet's config backup has been downloaded. Re-downloading
 *  refreshes the timestamp (excluded.downloaded_at) so the 90-day periodic
 *  reminder resets whenever the user grabs a fresh copy. */
export function markBackedUp(userId: number, kind: WalletKind, id: number): void {
	db.prepare(
		`INSERT INTO wallet_backups (user_id, wallet_kind, wallet_id) VALUES (?, ?, ?)
		 ON CONFLICT (wallet_kind, wallet_id) DO UPDATE SET downloaded_at = excluded.downloaded_at`
	).run(userId, kind, id);

	// Surface it in the user's activity feed ("Wallet backup downloaded"). Best-
	// effort via recordActivity, which never throws.
	const table = kind === 'multisig' ? 'multisigs' : 'wallets';
	const row = db.prepare(`SELECT name FROM ${table} WHERE id = ?`).get(id) as
		| { name: string }
		| undefined;
	const name = row?.name ?? 'your wallet';
	recordActivity({
		type: 'backup_downloaded',
		level: 'success',
		userId,
		message: `Backup downloaded for “${name}”`,
		detail: { walletKind: kind, walletId: id }
	});
}

/** Whether a wallet's config backup has been downloaded. */
export function isBackedUp(kind: WalletKind, id: number): boolean {
	return !!db
		.prepare('SELECT 1 FROM wallet_backups WHERE wallet_kind = ? AND wallet_id = ?')
		.get(kind, id);
}

/**
 * Multisig wallets that STILL need a backup — powers the persistent "back up your
 * wallet" banner. Scoped deliberately (see the module note): only multisigs
 * CREATED from scratch (source='created'), because their config exists nowhere
 * else. Single-sig wallets reconstruct from the hardware device, and imported
 * multisigs came from a config file the user already holds — neither is ever
 * nagged. One cheap anti-join.
 */
export function listUnbackedWallets(userId: number): UnbackedWallet[] {
	const multis = db
		.prepare(
			`SELECT m.id AS id, m.name AS name
			 FROM multisigs m
			 WHERE m.user_id = ? AND m.source = 'created'
			   AND NOT EXISTS (
			     SELECT 1 FROM wallet_backups b
			     WHERE b.wallet_kind = 'multisig' AND b.wallet_id = m.id
			   )
			 ORDER BY m.created_at ASC, m.id ASC`
		)
		.all(userId) as { id: number; name: string }[];

	return multis.map((m): UnbackedWallet => ({
		kind: 'multisig',
		id: m.id,
		name: m.name,
		href: `/wallets/multisig/${m.id}`
	}));
}

// -------------------------------------------------- 90-day periodic reminder

/** Backups aren't a one-time chore: keys can be added, wallets renamed, and a
 *  backup from a year ago may no longer match the setup. This window is how
 *  stale a backup can get (and how long a dismissal lasts) before we gently
 *  nudge for fresh copies. */
const REMINDER_DAYS = 90;

/** Whether an ISO timestamp is older than REMINDER_DAYS ago (null = never, so
 *  treated as stale). */
function olderThanWindow(iso: string | null): boolean {
	if (!iso) return true;
	const then = Date.parse(iso);
	if (Number.isNaN(then)) return true;
	return Date.now() - then > REMINDER_DAYS * 24 * 60 * 60 * 1000;
}

/**
 * Whether to show the gentle "download fresh backups" reminder. True only when
 * the user HAS at least one backed-up wallet whose most-recent download is
 * older than 90 days AND they haven't dismissed the reminder within the last 90
 * days. A user with no backups at all is handled by the separate unbacked
 * banner (listUnbackedWallets), so this stays quiet for them.
 *
 * One round trip (cairn-xlrm): this used to be two sequential queries (latest
 * backup timestamp, then — only if that existed and was stale — the dismissal
 * row), which serializes badly since this runs on every (app) layout load.
 * Fetching both in a single query with subselects costs the same as the
 * cheap (no-backups) path used to and is strictly fewer round trips whenever
 * a dismissal check would have run at all.
 */
export function shouldShowBackupReminder(userId: number): boolean {
	const row = db
		.prepare(
			`SELECT
				(SELECT MAX(b.downloaded_at)
				 FROM wallet_backups b JOIN multisigs m ON m.id = b.wallet_id
				 WHERE b.user_id = ? AND b.wallet_kind = 'multisig' AND m.source = 'created') AS latest,
				(SELECT dismissed_at FROM backup_reminders WHERE user_id = ?) AS dismissed_at`
		)
		.get(userId, userId) as { latest: string | null; dismissed_at: string | null };

	// No backups on record → the unbacked banner owns that case; don't double up.
	if (!row.latest) return false;
	if (!olderThanWindow(row.latest)) return false;
	// A recent dismissal silences the reminder for another full window.
	return olderThanWindow(row.dismissed_at);
}

/** Record that the user dismissed the periodic reminder now, silencing it for
 *  another REMINDER_DAYS. Idempotent per user. */
export function dismissBackupReminder(userId: number): void {
	db.prepare(
		`INSERT INTO backup_reminders (user_id, dismissed_at)
		 VALUES (?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
		 ON CONFLICT (user_id) DO UPDATE SET dismissed_at = excluded.dismissed_at`
	).run(userId);
}

// ------------------------------------ decaying backup nudge (cairn-gt05.5)
// docs/UX-BACKUP-NUDGE-AND-FIRST-DEPOSIT-SPEC.md Spec A. See db.ts's
// backup_nudges comment for how this table differs from the 90-day reminder
// above. This replaces the old "show whenever any wallet is unbacked, dismiss
// only for the session" banner logic with a server-persisted decay cadence
// (F16: a fixed/per-session cadence habituates into wallpaper, then alarm
// fatigue) plus state-driven escalation for genuinely stakes-raising events.

/** Stakes tiers for a still-unbacked wallet, monotonic — only ever raised. */
export const BACKUP_NUDGE_BUCKET = { NEW: 0, MULTI: 1, FUNDED: 2 } as const;
type BackupNudgeBucket = (typeof BACKUP_NUDGE_BUCKET)[keyof typeof BACKUP_NUDGE_BUCKET];

/** Decay ladder (ms), indexed by (shownCount - 1) and clamped to the last
 *  (quarterly) rung once shownCount exceeds it — "cadence widens, never
 *  shortens." Rung 0 (+3 days) is deliberately equal to HARD_CAP_MS below;
 *  see nextEligibleAt's doc comment for why that equality matters. */
const DECAY_MS = [3, 10, 30, 90].map((days) => days * 24 * 60 * 60 * 1000);

/** Never show the same wallet's nudge more than once per 72h, regardless of
 *  decay or escalation — the rule that keeps this from ever becoming a
 *  per-session ritual (F16, docs/UX-PSYCHOLOGY-RESEARCH-R2-2026-07-18.md). */
const HARD_CAP_MS = 72 * 60 * 60 * 1000;

/**
 * Pure decay-schedule function: given the epoch-ms a wallet's nudge was last
 * shown (null = never shown) and how many times it's shown, returns the
 * epoch-ms it next becomes eligible. Exported for unit testing.
 *
 * shownCount === 0 paired with a non-null lastShownAtMs is a deliberate
 * sentinel that never arises from a normal showing (those always set
 * last_shown_at and increment shown_count together): raiseBucket() below
 * uses it to mean "an escalation raised the stakes bucket before the 72h cap
 * had elapsed since the last real showing." Because rung 0 of the ladder
 * (+3 days) is numerically identical to HARD_CAP_MS, that sentinel collapses
 * to exactly "due 72h after the last showing" through this same formula —
 * escalation bypasses the wider rungs without a separate code path.
 */
export function nextEligibleAt(lastShownAtMs: number | null, shownCount: number): number {
	if (lastShownAtMs === null) return 0; // never shown, or fully re-earned — due now
	const idx = Math.min(Math.max(shownCount - 1, 0), DECAY_MS.length - 1);
	return lastShownAtMs + DECAY_MS[idx];
}

interface BackupNudgeRow {
	first_seen_at: string;
	last_shown_at: string | null;
	shown_count: number;
	stakes_bucket: number;
}

/** Whether raising to `newBucket` changes anything (buckets only ever rise),
 *  and if so, the new {last_shown_at, shown_count, stakes_bucket} to persist.
 *  Bypasses the decay ladder but never the 72h cap: if the cap already
 *  elapsed since the last real showing, the nudge re-earns immediately
 *  (last_shown_at cleared); otherwise the raise is recorded but showing stays
 *  deferred until the cap elapses (last_shown_at left untouched, shown_count
 *  reset to the sentinel described in nextEligibleAt). */
function raiseBucket(
	lastShownAtIso: string | null,
	shownCount: number,
	storedBucket: number,
	newBucket: number,
	nowMs: number
): { last_shown_at: string | null; shown_count: number; stakes_bucket: number } | null {
	if (newBucket <= storedBucket) return null;
	const lastShownMs = lastShownAtIso ? Date.parse(lastShownAtIso) : null;
	const capElapsed = lastShownMs === null || nowMs - lastShownMs >= HARD_CAP_MS;
	return {
		stakes_bucket: newBucket,
		last_shown_at: capElapsed ? null : lastShownAtIso,
		shown_count: capElapsed ? shownCount : 0
	};
}

function loadNudgeRow(userId: number, walletId: number): BackupNudgeRow | undefined {
	return db
		.prepare(
			`SELECT first_seen_at, last_shown_at, shown_count, stakes_bucket
			 FROM backup_nudges WHERE user_id = ? AND wallet_kind = 'multisig' AND wallet_id = ?`
		)
		.get(userId, walletId) as BackupNudgeRow | undefined;
}

function writeNudgeRow(
	userId: number,
	walletId: number,
	fields: { last_shown_at: string | null; shown_count: number; stakes_bucket: number }
): void {
	db.prepare(
		`UPDATE backup_nudges SET last_shown_at = ?, shown_count = ?, stakes_bucket = ?
		 WHERE user_id = ? AND wallet_kind = 'multisig' AND wallet_id = ?`
	).run(fields.last_shown_at, fields.shown_count, fields.stakes_bucket, userId, walletId);
}

/**
 * Raise a wallet's stakes bucket from an event outside the layout-load path —
 * today, only the "this unbacked wallet just received its first funds" hook
 * (src/lib/server/addressWatcher.ts). Best-effort and silent: a missed
 * escalation just means the nudge falls back to its normal decay cadence,
 * never a broken page. No-ops for anything that isn't an unbacked,
 * `source = 'created'` multisig — imported configs and single-sig wallets are
 * never nudged at all (see listUnbackedWallets).
 */
export function escalateBackupNudge(
	userId: number,
	walletId: number,
	bucket: BackupNudgeBucket
): void {
	try {
		const wallet = db
			.prepare(`SELECT source FROM multisigs WHERE id = ? AND user_id = ?`)
			.get(walletId, userId) as { source: string } | undefined;
		if (!wallet || wallet.source !== 'created') return;
		if (isBackedUp('multisig', walletId)) return;

		const now = Date.now();
		const nowIso = new Date(now).toISOString();
		const row = loadNudgeRow(userId, walletId);
		if (!row) {
			db.prepare(
				`INSERT INTO backup_nudges
				   (user_id, wallet_kind, wallet_id, first_seen_at, last_shown_at, shown_count, stakes_bucket)
				 VALUES (?, 'multisig', ?, ?, NULL, 0, ?)`
			).run(userId, walletId, nowIso, bucket);
			return;
		}
		const raised = raiseBucket(row.last_shown_at, row.shown_count, row.stakes_bucket, bucket, now);
		if (raised) writeNudgeRow(userId, walletId, raised);
	} catch (e) {
		log.error({ err: e, userId, walletId }, 'escalateBackupNudge failed (ignored)');
	}
}

/** One due backup nudge (decayed cadence, polymorphic copy) for the layout's
 *  amber banner. Oldest still-unbacked wallet wins ties. Copy strings
 *  themselves live client-side, keyed by variantId, so wording stays next to
 *  styling (see (app)/+layout.svelte). */
export interface BackupNudge {
	walletId: number;
	walletKind: WalletKind;
	name: string;
	href: string;
	unbackedCount: number;
	variantId: string; // 'V1'..'V5' (calm rotation) | 'E-FUNDED' | 'E-MULTI'
	tone: 'calm' | 'escalated';
}

export function getDueBackupNudge(userId: number): BackupNudge | null {
	const unbacked = listUnbackedWallets(userId);
	if (unbacked.length === 0) return null;

	const now = Date.now();
	const nowIso = new Date(now).toISOString();
	// A second unbacked wallet is a free, load-time-computable escalation
	// trigger (no new data needed) — applies uniformly to every unbacked
	// wallet's row, since it's a fact about the whole set, not one wallet.
	const liveFloor: BackupNudgeBucket =
		unbacked.length >= 2 ? BACKUP_NUDGE_BUCKET.MULTI : BACKUP_NUDGE_BUCKET.NEW;

	for (const w of unbacked) {
		let row = loadNudgeRow(userId, w.id);
		if (!row) {
			db.prepare(
				`INSERT INTO backup_nudges
				   (user_id, wallet_kind, wallet_id, first_seen_at, last_shown_at, shown_count, stakes_bucket)
				 VALUES (?, 'multisig', ?, ?, NULL, 0, 0)`
			).run(userId, w.id, nowIso);
			row = { first_seen_at: nowIso, last_shown_at: null, shown_count: 0, stakes_bucket: 0 };
		}

		const raised = raiseBucket(row.last_shown_at, row.shown_count, row.stakes_bucket, liveFloor, now);
		if (raised) {
			writeNudgeRow(userId, w.id, raised);
			row = { ...row, ...raised };
		}

		const lastShownMs = row.last_shown_at ? Date.parse(row.last_shown_at) : null;
		if (now < nextEligibleAt(lastShownMs, row.shown_count)) continue; // not due yet

		// An unshown escalation breaks the normal correlation between
		// shown_count===0 and last_shown_at===null (see nextEligibleAt) — that
		// mismatch is the signal to use the escalated copy this one showing.
		const pendingEscalation =
			row.stakes_bucket > BACKUP_NUDGE_BUCKET.NEW &&
			(row.shown_count === 0) !== (row.last_shown_at === null);

		const variantId = pendingEscalation
			? row.stakes_bucket >= BACKUP_NUDGE_BUCKET.FUNDED
				? 'E-FUNDED'
				: 'E-MULTI'
			: `V${(row.shown_count % 5) + 1}`;

		writeNudgeRow(userId, w.id, {
			last_shown_at: nowIso,
			shown_count: row.shown_count + 1,
			stakes_bucket: row.stakes_bucket
		});

		return {
			walletId: w.id,
			walletKind: w.kind,
			name: w.name,
			href: w.href,
			unbackedCount: unbacked.length,
			variantId,
			tone: pendingEscalation ? 'escalated' : 'calm'
		};
	}

	return null;
}
