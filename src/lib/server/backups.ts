// Wallet-config backup status, tracked server-side. A wallet's configuration —
// its public keys and settings — is what's needed to find its bitcoin and, for
// multisig, to RECONSTRUCT the wallet at all; losing it (with Cairn's data
// gone) can mean permanently losing access to funds. So we treat "has the user
// downloaded this wallet's backup?" as first-class state, not a client-only
// flag. See db.ts (wallet_backups) and the creation wizards / persistent banner.

import { db } from './db';
import { recordActivity } from './activity';
import type { WalletKind } from '$lib/types';

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
 * Every wallet (single-sig and multisig) the user owns that has no backup on
 * record — powers the persistent "back up your wallets" banner. Cheap: two
 * anti-joins against the small wallet_backups table.
 */
export function listUnbackedWallets(userId: number): UnbackedWallet[] {
	const singles = db
		.prepare(
			`SELECT w.id AS id, w.name AS name
			 FROM wallets w
			 WHERE w.user_id = ?
			   AND NOT EXISTS (
			     SELECT 1 FROM wallet_backups b
			     WHERE b.wallet_kind = 'wallet' AND b.wallet_id = w.id
			   )
			 ORDER BY w.created_at ASC, w.id ASC`
		)
		.all(userId) as { id: number; name: string }[];

	const multis = db
		.prepare(
			`SELECT m.id AS id, m.name AS name
			 FROM multisigs m
			 WHERE m.user_id = ?
			   AND NOT EXISTS (
			     SELECT 1 FROM wallet_backups b
			     WHERE b.wallet_kind = 'multisig' AND b.wallet_id = m.id
			   )
			 ORDER BY m.created_at ASC, m.id ASC`
		)
		.all(userId) as { id: number; name: string }[];

	return [
		...singles.map((w): UnbackedWallet => ({ kind: 'wallet', id: w.id, name: w.name, href: `/wallets/${w.id}` })),
		...multis.map((m): UnbackedWallet => ({
			kind: 'multisig',
			id: m.id,
			name: m.name,
			href: `/wallets/multisig/${m.id}`
		}))
	];
}

// -------------------------------------------------- 90-day periodic reminder

/** Backups aren't a one-time chore: keys can be added, wallets renamed, and a
 *  backup from a year ago may no longer match the setup. This window is how
 *  stale a backup can get (and how long a dismissal lasts) before we gently
 *  nudge for fresh copies. */
const REMINDER_DAYS = 90;

/** The most recent moment this user downloaded ANY of their wallet backups, as
 *  an ISO string — or null if they have never downloaded one. */
function lastBackupAt(userId: number): string | null {
	const row = db
		.prepare('SELECT MAX(downloaded_at) AS latest FROM wallet_backups WHERE user_id = ?')
		.get(userId) as { latest: string | null } | undefined;
	return row?.latest ?? null;
}

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
 */
export function shouldShowBackupReminder(userId: number): boolean {
	const latest = lastBackupAt(userId);
	// No backups on record → the unbacked banner owns that case; don't double up.
	if (!latest) return false;
	if (!olderThanWindow(latest)) return false;

	const row = db
		.prepare('SELECT dismissed_at FROM backup_reminders WHERE user_id = ?')
		.get(userId) as { dismissed_at: string | null } | undefined;
	// A recent dismissal silences the reminder for another full window.
	return olderThanWindow(row?.dismissed_at ?? null);
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
