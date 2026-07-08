// Self-service account deletion (cairn-5u2i.2) — the user-initiated counterpart
// to admin.ts's deleteUser, scoped to the caller's own id. One transaction
// removes the user row (most tables cascade via their users FK) plus everything
// the schema can't cascade:
//
//   • invites.created_by and feature_flags/user_feature_flags.updated_by have
//     no ON DELETE action — a plain user-row delete would violate the FK.
//   • notified_txids has no FK on user_id at all, so its rows for this user are
//     removed by hand below.
//   • address_labels, wallet_backups, backup_missing_notified, and
//     balance_snapshots key off (wallet_kind, wallet_id) with no FK to
//     wallets/multisigs either — but db.ts's trg_wallets_delete_children /
//     trg_multisigs_delete_children AFTER DELETE triggers sweep those the
//     moment the wallets/multisigs rows disappear via the users FK cascade
//     below (cairn-97ui), so nothing further is needed here for them.
//
// Multisigs the user merely PARTICIPATED in (viewer/cosigner via
// multisig_shares) survive intact for their owner — only the share row goes
// (shared_with_id cascade). Multisigs the user OWNS are deleted with them.

import { db } from './db';
import { AuthError } from './auth';
import { childLogger } from './logger';

const log = childLogger('account-deletion');

/**
 * Delete the caller's own account and everything they own. Throws AuthError
 * ('not_found' for a missing user; 'last_admin' when the caller is the only
 * active administrator — deleting them would orphan the instance).
 */
export function deleteOwnAccount(userId: number): void {
	const user = db
		.prepare('SELECT id, is_admin, disabled FROM users WHERE id = ?')
		.get(userId) as { id: number; is_admin: number; disabled: number } | undefined;
	if (!user) throw new AuthError('User not found.', 'not_found');

	if (user.is_admin === 1 && user.disabled === 0) {
		const admins = (
			db.prepare('SELECT COUNT(*) AS n FROM users WHERE is_admin = 1 AND disabled = 0').get() as {
				n: number;
			}
		).n;
		if (admins <= 1) {
			throw new AuthError(
				'You are the only administrator. Promote another admin (or reset the instance) before deleting this account.',
				'last_admin'
			);
		}
	}

	// Owned wallet/multisig counts, captured before the cascade removes the
	// rows — used only for the log line below.
	const walletCount = (
		db.prepare('SELECT COUNT(*) AS n FROM wallets WHERE user_id = ?').get(userId) as { n: number }
	).n;
	const multisigCount = (
		db.prepare('SELECT COUNT(*) AS n FROM multisigs WHERE user_id = ?').get(userId) as {
			n: number;
		}
	).n;

	db.prepare('BEGIN').run();
	try {
		// FK targets with no ON DELETE action — clear before the user row goes.
		db.prepare('DELETE FROM invites WHERE created_by = ?').run(userId);
		db.prepare('UPDATE feature_flags SET updated_by = NULL WHERE updated_by = ?').run(userId);
		db.prepare('UPDATE user_feature_flags SET updated_by = NULL WHERE updated_by = ?').run(userId);

		// The user row — sessions, credentials, wallets (and their transactions/
		// tx_labels), owned multisigs (keys/transactions/registrations), share
		// rows in BOTH directions, saved addresses, notification config/queue,
		// events, balance snapshots, devices, acceptances, and contacts all
		// cascade from here. The wallets/multisigs rows disappearing here in turn
		// fires trg_wallets_delete_children / trg_multisigs_delete_children,
		// sweeping address_labels/wallet_backups/backup_missing_notified/
		// balance_snapshots for them (cairn-97ui).
		db.prepare('DELETE FROM users WHERE id = ?').run(userId);

		// notified_txids.user_id has no FK at all (not even the polymorphic
		// wallet_kind/wallet_id triggers reach it by user), so it's never
		// touched by the cascade above — clear this user's rows by hand.
		db.prepare('DELETE FROM notified_txids WHERE user_id = ?').run(userId);

		db.prepare('COMMIT').run();
	} catch (e) {
		db.prepare('ROLLBACK').run();
		throw e;
	}

	log.info({ userId, wallets: walletCount, multisigs: multisigCount }, 'user deleted their own account');
}
