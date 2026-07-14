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
import {
	deletionOrphansAdmins,
	ownedSharedMultisigs,
	purgeUserRow,
	notifyOwnerDeletionCosigners,
	hasLiveBroadcastClaimForUser,
	pendingCosignerAssignments,
	notifyCosignerDeparture,
	type UserDeletionRow
} from './userDeletion';

const log = childLogger('account-deletion');

/**
 * Delete the caller's own account and everything they own. Throws AuthError
 * ('not_found' for a missing user; 'last_admin' when the caller is the only
 * usable administrator — deleting them would orphan the instance).
 *
 * A self-delete is NOT blocked when the user owns multisigs shared with others:
 * the danger-zone copy already warns those wallets are destroyed for everyone
 * (cairn-8r0l UX half, 2d67da8), and a user must always be able to close their
 * own account. Instead the affected cosigners are notified so the wallets don't
 * simply vanish on them without a word.
 */
export function deleteOwnAccount(userId: number): void {
	const user = db
		.prepare('SELECT id, is_admin, disabled, display_name, email FROM users WHERE id = ?')
		.get(userId) as (UserDeletionRow & { display_name: string; email: string }) | undefined;
	if (!user) throw new AuthError('User not found.', 'not_found');

	// Last-admin guard, now robust to a disabled sole admin (cairn-sclk).
	if (deletionOrphansAdmins(user)) {
		throw new AuthError(
			'You are the only administrator. Promote another admin (or reset the instance) before deleting this account.',
			'last_admin'
		);
	}

	// cairn-vop2: refuse while a transaction in any owned wallet/multisig has a
	// live broadcast claim — this whole-account cascade bypasses
	// deleteWallet()/deleteMultisig()'s own per-object guard. The claim expires
	// in well under a minute, so this is a "try again shortly" block, not a
	// permanent one.
	if (hasLiveBroadcastClaimForUser(userId)) {
		throw new AuthError(
			'A transaction in one of your wallets is being broadcast right now. Please try deleting your account again in a minute.',
			'broadcast_in_progress'
		);
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

	// Enumerate shared-out multisigs BEFORE the cascade destroys them, so we can
	// tell their collaborators afterward (cairn-8r0l).
	const shared = ownedSharedMultisigs(userId);
	// cairn-z93o: same idea, the other direction — multisigs this user CO-SIGNS
	// (not owns) with a pending unsigned slot. The owner needs to know a signer
	// just left mid-quorum, not just cosigners of wallets THEY themselves own.
	const cosigned = pendingCosignerAssignments(userId);

	purgeUserRow(userId);

	// Post-commit, best-effort: the wallets are gone, now let their cosigners know.
	const label = user.display_name || user.email;
	notifyOwnerDeletionCosigners(shared, label);
	notifyCosignerDeparture(cosigned, label);

	log.info(
		{
			userId,
			wallets: walletCount,
			multisigs: multisigCount,
			sharedMultisigs: shared.length,
			cosignedWithPendingSlot: cosigned.length
		},
		'user deleted their own account'
	);
}
