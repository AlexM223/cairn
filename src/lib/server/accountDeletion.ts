// Self-service account deletion (cairn-5u2i.2) — the user-initiated counterpart
// to admin.ts's deleteUser, scoped to the caller's own id. One transaction
// removes the user row (most tables cascade via their users FK) plus everything
// the schema can't cascade:
//
//   • invites.created_by and feature_flags/user_feature_flags.updated_by have
//     no ON DELETE action — a plain user-row delete would violate the FK.
//   • notified_txids, address_labels, wallet_backups, and
//     backup_missing_notified carry no FK at all (wallet_kind/wallet_id or
//     user_id shape), so their rows for the user's wallets are removed by hand,
//     mirroring deleteWallet/deleteMultisig's per-wallet cleanup.
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

	// Owned wallet ids, captured before the cascade removes the rows — the
	// no-FK tables below are keyed by (wallet_kind, wallet_id).
	const walletIds = (
		db.prepare('SELECT id FROM wallets WHERE user_id = ?').all(userId) as { id: number }[]
	).map((r) => r.id);
	const multisigIds = (
		db.prepare('SELECT id FROM multisigs WHERE user_id = ?').all(userId) as { id: number }[]
	).map((r) => r.id);

	const cleanupByWallet = (table: string, kind: 'wallet' | 'multisig', ids: number[]) => {
		if (ids.length === 0) return;
		db.prepare(
			`DELETE FROM ${table} WHERE wallet_kind = ? AND wallet_id IN (${ids.map(() => '?').join(', ')})`
		).run(kind, ...ids);
	};

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
		// cascade from here.
		db.prepare('DELETE FROM users WHERE id = ?').run(userId);

		// No-FK tables, mirroring deleteWallet/deleteMultisig's hand cleanup.
		db.prepare('DELETE FROM notified_txids WHERE user_id = ?').run(userId);
		for (const table of ['address_labels', 'wallet_backups', 'backup_missing_notified']) {
			cleanupByWallet(table, 'wallet', walletIds);
			cleanupByWallet(table, 'multisig', multisigIds);
		}

		db.prepare('COMMIT').run();
	} catch (e) {
		db.prepare('ROLLBACK').run();
		throw e;
	}

	log.info(
		{ userId, wallets: walletIds.length, multisigs: multisigIds.length },
		'user deleted their own account'
	);
}
