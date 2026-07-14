// Shared user-deletion primitives used by BOTH admin.ts's deleteUser (an admin
// removing someone else) and accountDeletion.ts's deleteOwnAccount (a user
// removing themselves). Centralised here so the three invariants below can never
// drift between the two entry points again:
//
//   1. FK pre-cleanup (cairn-piow). A bare `DELETE FROM users` violates the
//      three user FKs that have NO `ON DELETE` action — invites.created_by,
//      feature_flags.updated_by, user_feature_flags.updated_by — and throws a
//      raw "FOREIGN KEY constraint failed". Every non-cascade user FK in the
//      schema is exactly these three (audited 2026-07-12: all other user FKs are
//      ON DELETE CASCADE, plus multisig_keys.assigned_user_id ON DELETE SET
//      NULL). purgeUserRow() clears them inside the delete transaction.
//
//   2. Last-admin guard (cairn-sclk). The instance must always retain a usable
//      administrator. The old guard counted only ACTIVE admins (is_admin=1 AND
//      disabled=0), so a DISABLED sole admin slipped through and self-delete left
//      zero admin rows — recoverable only by direct DB surgery.
//      deletionOrphansAdmins() closes that gap by also refusing to drop the last
//      admin ROW of any kind.
//
//   3. Shared-multisig owner deletion (cairn-8r0l). multisigs.user_id is ON
//      DELETE CASCADE, so deleting an owner silently destroys every multisig they
//      own — including ones shared OUT to cosigners/viewers, along with any
//      in-flight PSBTs — with no signal to the collaborators. ownedSharedMultisigs()
//      enumerates the affected wallets BEFORE the cascade (so names/participants
//      survive to describe them), and notifyOwnerDeletionCosigners() fires an
//      in-app `multisig_removed` notification to each affected participant AFTER
//      the delete commits.

import { db } from './db';
import { notify } from './notifications';
import { childLogger } from './logger';

const log = childLogger('user-deletion');

export interface UserDeletionRow {
	id: number;
	is_admin: number;
	disabled: number;
}

/** One owned multisig that is shared OUT to at least one other participant. */
export interface OwnedSharedMultisig {
	multisigId: number;
	name: string;
	/** Distinct shared_with_id of every participant (viewers + cosigners). */
	participantIds: number[];
	/** Transactions currently `awaiting_signature` (in-flight PSBTs destroyed). */
	pendingTxCount: number;
}

function scalar(sql: string, ...params: (string | number)[]): number {
	return (db.prepare(sql).get(...params) as { n: number }).n;
}

/**
 * cairn-vop2: deleting a user cascades away every wallet/multisig they own
 * (wallets.user_id / multisigs.user_id ON DELETE CASCADE), which in turn
 * cascades their transactions — bypassing deleteWallet()/deleteMultisig()'s
 * own hasLiveBroadcastClaim guard entirely, since this path deletes the user
 * row directly. Mirrors that same guard (and its 60s staleness window, so a
 * crashed broadcast can't wedge account deletion forever) across every
 * wallet/multisig the user owns. MUST be called before purgeUserRow().
 */
export function hasLiveBroadcastClaimForUser(userId: number): boolean {
	const liveTx = scalar(
		`SELECT COUNT(*) AS n FROM transactions t
		   JOIN wallets w ON w.id = t.wallet_id
		  WHERE w.user_id = ?
		    AND t.broadcast_started_at IS NOT NULL
		    AND t.broadcast_started_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-60 seconds')`,
		userId
	);
	if (liveTx > 0) return true;
	const liveMsTx = scalar(
		`SELECT COUNT(*) AS n FROM multisig_transactions mt
		   JOIN multisigs m ON m.id = mt.multisig_id
		  WHERE m.user_id = ?
		    AND mt.broadcast_started_at IS NOT NULL
		    AND mt.broadcast_started_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-60 seconds')`,
		userId
	);
	return liveMsTx > 0;
}

/**
 * Would deleting this user leave the instance without a usable administrator?
 *
 * A non-admin never can, so returns false immediately. For an admin target it
 * refuses in two independent situations:
 *   - no OTHER admin row of any kind would remain (covers a disabled sole admin —
 *     cairn-sclk — as well as the classic active sole admin), or
 *   - the target is itself a usable admin and no OTHER usable admin (is_admin=1
 *     AND disabled=0) would remain (preserves the pre-existing "can't delete the
 *     last active admin" behaviour even when a disabled admin row also exists).
 */
export function deletionOrphansAdmins(user: UserDeletionRow): boolean {
	if (user.is_admin !== 1) return false;
	const otherAdmins = scalar('SELECT COUNT(*) AS n FROM users WHERE is_admin = 1 AND id != ?', user.id);
	if (otherAdmins === 0) return true;
	if (user.disabled === 0) {
		const otherUsable = scalar(
			'SELECT COUNT(*) AS n FROM users WHERE is_admin = 1 AND disabled = 0 AND id != ?',
			user.id
		);
		if (otherUsable === 0) return true;
	}
	return false;
}

/**
 * Multisigs this user OWNS that are shared with at least one other participant.
 * Captured by value (name, participant ids, pending-tx count) so the details
 * survive the cascade that is about to destroy the rows. MUST be called before
 * the user row is deleted.
 */
export function ownedSharedMultisigs(userId: number): OwnedSharedMultisig[] {
	const owned = db
		.prepare(
			`SELECT m.id AS id, m.name AS name
			   FROM multisigs m
			  WHERE m.user_id = ?
			    AND EXISTS (SELECT 1 FROM multisig_shares s WHERE s.multisig_id = m.id)
			  ORDER BY m.id`
		)
		.all(userId) as { id: number; name: string }[];

	return owned.map((m) => {
		const participants = (
			db
				.prepare('SELECT DISTINCT shared_with_id AS uid FROM multisig_shares WHERE multisig_id = ?')
				.all(m.id) as { uid: number }[]
		).map((r) => r.uid);
		const pendingTxCount = scalar(
			"SELECT COUNT(*) AS n FROM multisig_transactions WHERE multisig_id = ? AND status = 'awaiting_signature'",
			m.id
		);
		return { multisigId: m.id, name: m.name, participantIds: participants, pendingTxCount };
	});
}

/** One multisig where this (about-to-be-deleted) user is a COSIGNER (not the
 *  owner) with at least one pending, unsigned signature slot. */
export interface PendingCosignerAssignment {
	multisigId: number;
	name: string;
	ownerId: number;
	/** How many awaiting_signature transactions still needed this user's signature. */
	pendingTxCount: number;
}

/**
 * cairn-z93o: multisig_transaction_signers.user_id and multisig_keys.assigned_
 * user_id both react to a user delete (cascade / SET NULL respectively), so a
 * cosigner's roster slot vanishes cleanly — but silently, with no signal to the
 * owner that a signer just left mid-quorum. Enumerates, BEFORE the cascade,
 * every multisig this user co-signs (not owns) that has a transaction still
 * awaiting_signature where this user hadn't signed yet. MUST be called before
 * purgeUserRow().
 */
export function pendingCosignerAssignments(userId: number): PendingCosignerAssignment[] {
	const rows = db
		.prepare(
			`SELECT m.id AS multisigId, m.name AS name, m.user_id AS ownerId,
			        COUNT(*) AS pendingTxCount
			   FROM multisig_transaction_signers s
			   JOIN multisig_transactions t ON t.id = s.transaction_id
			   JOIN multisigs m ON m.id = t.multisig_id
			  WHERE s.user_id = ?
			    AND s.has_signed = 0
			    AND t.status = 'awaiting_signature'
			    AND m.user_id != ?
			  GROUP BY m.id, m.name, m.user_id
			  ORDER BY m.id`
		)
		.all(userId, userId) as {
		multisigId: number;
		name: string;
		ownerId: number;
		pendingTxCount: number;
	}[];
	return rows;
}

/**
 * Fire a `cosigner_left` in-app notification to each affected multisig's owner
 * (best-effort, same contract as notifyOwnerDeletionCosigners: never turns a
 * successful deletion into an error). Call AFTER the delete commits, with the
 * list captured beforehand by pendingCosignerAssignments().
 */
export function notifyCosignerDeparture(
	assignments: PendingCosignerAssignment[],
	departedLabel: string
): void {
	for (const a of assignments) {
		try {
			notify({
				type: 'cosigner_left',
				userId: a.ownerId,
				level: 'warn',
				title: 'A cosigner left your shared wallet',
				body: `${departedLabel} deleted their account while still holding an unsigned slot on “${a.name}” — ${a.pendingTxCount} transaction${a.pendingTxCount === 1 ? '' : 's'} awaiting signature will need the roster reviewed. The PSBT and any signatures already collected are unaffected.`,
				detail: { multisigName: a.name, pendingTx: a.pendingTxCount },
				link: '/wallets'
			});
		} catch (e) {
			log.error(
				{ err: e, ownerId: a.ownerId, multisigId: a.multisigId },
				'cosigner-departure notice failed'
			);
		}
	}
}

/**
 * Delete the user row and the FK targets the schema can't cascade, in ONE
 * transaction. Order: clear the three no-cascade FKs, delete the user (all
 * cascading tables + the wallet/multisig delete triggers fire here), then the
 * no-FK-at-all notified_txids rows by hand. Throws (and rolls back) on any error.
 */
export function purgeUserRow(userId: number): void {
	db.prepare('BEGIN').run();
	try {
		// FK targets with no ON DELETE action — clear before the user row goes,
		// or SQLite raises "FOREIGN KEY constraint failed" (cairn-piow).
		db.prepare('DELETE FROM invites WHERE created_by = ?').run(userId);
		db.prepare('UPDATE feature_flags SET updated_by = NULL WHERE updated_by = ?').run(userId);
		db.prepare('UPDATE user_feature_flags SET updated_by = NULL WHERE updated_by = ?').run(userId);

		db.prepare('DELETE FROM users WHERE id = ?').run(userId);

		// notified_txids.user_id has no FK at all (not even the polymorphic
		// wallet_kind/wallet_id triggers reach it by user) — clear by hand.
		db.prepare('DELETE FROM notified_txids WHERE user_id = ?').run(userId);

		db.prepare('COMMIT').run();
	} catch (e) {
		db.prepare('ROLLBACK').run();
		throw e;
	}
}

/**
 * Fire the `multisig_removed` notification to every participant of each shared
 * multisig an owner just deleted. Best-effort (mirrors notify()'s own contract):
 * a failure here must never turn a successful deletion into an error. Call AFTER
 * purgeUserRow() commits, with the list captured beforehand by
 * ownedSharedMultisigs().
 */
export function notifyOwnerDeletionCosigners(
	shared: OwnedSharedMultisig[],
	ownerLabel: string
): void {
	for (const ms of shared) {
		const pending =
			ms.pendingTxCount > 0
				? ` This included ${ms.pendingTxCount} transaction${ms.pendingTxCount === 1 ? '' : 's'} awaiting signature.`
				: '';
		for (const uid of ms.participantIds) {
			try {
				notify({
					type: 'multisig_removed',
					userId: uid,
					level: 'warn',
					title: 'Shared wallet removed',
					body: `The shared multisig wallet “${ms.name}” is no longer available — its owner (${ownerLabel}) deleted their account, which permanently removed the wallet for everyone it was shared with.${pending} The bitcoin itself is unaffected; anyone holding the keys can still recover the funds from a wallet backup.`,
					detail: { multisigName: ms.name, pendingTx: ms.pendingTxCount },
					link: '/wallets'
				});
			} catch (e) {
				log.error({ err: e, recipientId: uid, multisigId: ms.multisigId }, 'cosigner deletion notice failed');
			}
		}
	}
}
