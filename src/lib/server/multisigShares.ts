// Collaborative custody: sharing a multisig wallet with another user on the SAME
// instance (see docs/COLLABORATIVE-CUSTODY-PLAN.md §3, §6). Single-instance only —
// no federation. Sharing is friends-only: the target must be an accepted contact.
//
// Key-to-user assignment lives on multisig_keys.assigned_user_id (not on the
// share row), so a user holding two of a wallet's keys is simply two key rows
// with the same assigned_user_id — no special-casing anywhere.

import { db } from './db';
import { areContacts } from './contacts';
import { getMultisig, type MultisigKeyRow, type MultisigRow } from './wallets/multisig';

export type ShareRole = 'viewer' | 'cosigner';
const ROLES: ShareRole[] = ['viewer', 'cosigner'];

export class ShareError extends Error {
	code: 'not_owner' | 'not_contact' | 'bad_role' | 'bad_keys' | 'not_found' | 'self';

	constructor(message: string, code: ShareError['code']) {
		super(message);
		this.name = 'ShareError';
		this.code = code;
	}
}

/** A collaborator on a wallet, from the owner's point of view. */
export interface Collaborator {
	shareId: number;
	userId: number;
	displayName: string;
	email: string;
	role: ShareRole;
	/** multisig_keys.id values currently assigned to this collaborator. */
	assignedKeyIds: number[];
}

/** A wallet shared WITH the caller — for their own /wallets list. */
export interface SharedMultisigSummary {
	multisigId: number;
	name: string;
	threshold: number;
	role: ShareRole;
	ownerId: number;
	ownerName: string;
}

interface ShareRow {
	id: number;
	multisig_id: number;
	owner_id: number;
	shared_with_id: number;
	role: string;
}

function requireOwned(ownerId: number, multisigId: number): MultisigRow {
	const ms = getMultisig(ownerId, multisigId);
	if (!ms) throw new ShareError('Wallet not found.', 'not_owner');
	return ms;
}

/**
 * Assign a set of the wallet's keys to a user, after validating each key
 * belongs to this exact multisig and isn't already claimed by someone else.
 * Passing an empty array clears this user's assignments on this wallet first.
 */
function assignKeys(multisigId: number, userId: number, keyIds: number[]): void {
	// Every id must be a key of THIS multisig, and either unassigned or already
	// this user's (re-assigning your own keys is a no-op, not a conflict).
	for (const keyId of keyIds) {
		const key = db
			.prepare('SELECT assigned_user_id FROM multisig_keys WHERE id = ? AND multisig_id = ?')
			.get(keyId, multisigId) as { assigned_user_id: number | null } | undefined;
		if (!key) throw new ShareError('A selected key does not belong to this wallet.', 'bad_keys');
		if (key.assigned_user_id != null && key.assigned_user_id !== userId) {
			throw new ShareError('A selected key is already assigned to someone else.', 'bad_keys');
		}
	}
	// Clear this user's current assignments on the wallet, then set the new set.
	db.prepare(
		'UPDATE multisig_keys SET assigned_user_id = NULL WHERE multisig_id = ? AND assigned_user_id = ?'
	).run(multisigId, userId);
	const claim = db.prepare(
		'UPDATE multisig_keys SET assigned_user_id = ? WHERE id = ? AND multisig_id = ?'
	);
	for (const keyId of keyIds) claim.run(userId, keyId, multisigId);
}

/**
 * Share a multisig with an accepted contact. `role='cosigner'` optionally
 * assigns one or more currently-unassigned keys to them (or leave for later —
 * "decide later" is a valid state). Throws ShareError on ownership/contact/key
 * problems.
 */
export function shareMultisig(
	ownerId: number,
	multisigId: number,
	contactUserId: number,
	role: ShareRole,
	keyIds: number[] = []
): void {
	requireOwned(ownerId, multisigId);
	if (contactUserId === ownerId) throw new ShareError('You already own this wallet.', 'self');
	if (!ROLES.includes(role)) throw new ShareError('Unknown share role.', 'bad_role');
	if (!areContacts(ownerId, contactUserId)) {
		throw new ShareError('You can only share with an accepted contact.', 'not_contact');
	}

	db.prepare(
		`INSERT INTO multisig_shares (multisig_id, owner_id, shared_with_id, role)
		 VALUES (?, ?, ?, ?)
		 ON CONFLICT (multisig_id, shared_with_id) DO UPDATE SET role = excluded.role`
	).run(multisigId, ownerId, contactUserId, role);

	if (role === 'cosigner' && keyIds.length) {
		assignKeys(multisigId, contactUserId, keyIds);
	} else if (role === 'viewer') {
		// A viewer holds no keys — clear any it had if downgraded from cosigner.
		assignKeys(multisigId, contactUserId, []);
	}
}

/** Change a share's role and/or reassign its keys. */
export function updateMultisigShare(
	ownerId: number,
	shareId: number,
	changes: { role?: ShareRole; keyIds?: number[] }
): void {
	const share = db
		.prepare('SELECT * FROM multisig_shares WHERE id = ? AND owner_id = ?')
		.get(shareId, ownerId) as ShareRow | undefined;
	if (!share) throw new ShareError('Share not found.', 'not_found');

	const role = changes.role ?? (share.role as ShareRole);
	if (!ROLES.includes(role)) throw new ShareError('Unknown share role.', 'bad_role');
	db.prepare('UPDATE multisig_shares SET role = ? WHERE id = ?').run(role, shareId);

	if (role === 'viewer') {
		assignKeys(share.multisig_id, share.shared_with_id, []);
	} else if (changes.keyIds) {
		assignKeys(share.multisig_id, share.shared_with_id, changes.keyIds);
	}
}

/**
 * Revoke a share: delete the row and clear any key assignments that pointed at
 * this user for this wallet. Deliberately does NOT retroactively pull the user
 * off an already-created, in-flight transaction roster (the roster is frozen at
 * creation time — see the plan §3 and the revoke UI's confirmation copy).
 */
export function revokeMultisigShare(ownerId: number, shareId: number): boolean {
	const share = db
		.prepare('SELECT * FROM multisig_shares WHERE id = ? AND owner_id = ?')
		.get(shareId, ownerId) as ShareRow | undefined;
	if (!share) return false;
	db.prepare(
		'UPDATE multisig_keys SET assigned_user_id = NULL WHERE multisig_id = ? AND assigned_user_id = ?'
	).run(share.multisig_id, share.shared_with_id);
	db.prepare('DELETE FROM multisig_shares WHERE id = ?').run(shareId);
	return true;
}

/**
 * Revoke every multisig share BETWEEN two users, in both directions (A owns and
 * shared with B, and B owns and shared with A), unassigning any keys. Used when
 * the contact relationship that authorized the sharing ends (cairn-2oex).
 * Returns the number of shares revoked.
 */
export function revokeAllSharesBetween(userA: number, userB: number): number {
	const shares = db
		.prepare(
			`SELECT id, multisig_id, shared_with_id FROM multisig_shares
			  WHERE (owner_id = ? AND shared_with_id = ?)
			     OR (owner_id = ? AND shared_with_id = ?)`
		)
		.all(userA, userB, userB, userA) as {
		id: number;
		multisig_id: number;
		shared_with_id: number;
	}[];

	for (const s of shares) {
		// Same teardown as revokeMultisigShare: unassign keys, then drop the share.
		db.prepare(
			'UPDATE multisig_keys SET assigned_user_id = NULL WHERE multisig_id = ? AND assigned_user_id = ?'
		).run(s.multisig_id, s.shared_with_id);
		db.prepare('DELETE FROM multisig_shares WHERE id = ?').run(s.id);
	}
	return shares.length;
}

/** Everyone this wallet is shared with, with their assigned keys (owner view). */
export function listCollaborators(ownerId: number, multisigId: number): Collaborator[] {
	requireOwned(ownerId, multisigId);
	const rows = db
		.prepare(
			`SELECT s.id AS share_id, s.shared_with_id AS user_id, s.role AS role,
			        u.display_name AS display_name, u.email AS email
			 FROM multisig_shares s JOIN users u ON u.id = s.shared_with_id
			 WHERE s.multisig_id = ?
			 ORDER BY u.display_name COLLATE NOCASE ASC`
		)
		.all(multisigId) as {
		share_id: number;
		user_id: number;
		role: string;
		display_name: string;
		email: string;
	}[];

	return rows.map((r) => {
		const keyIds = (
			db
				.prepare('SELECT id FROM multisig_keys WHERE multisig_id = ? AND assigned_user_id = ?')
				.all(multisigId, r.user_id) as { id: number }[]
		).map((k) => k.id);
		return {
			shareId: r.share_id,
			userId: r.user_id,
			displayName: r.display_name,
			email: r.email,
			role: r.role as ShareRole,
			assignedKeyIds: keyIds
		};
	});
}

/** Multisig wallets shared WITH this user (they don't own them). */
export function listSharedMultisigs(userId: number): SharedMultisigSummary[] {
	return (
		db
			.prepare(
				`SELECT m.id AS multisig_id, m.name AS name, m.threshold AS threshold,
				        s.role AS role, s.owner_id AS owner_id, u.display_name AS owner_name
				 FROM multisig_shares s
				 JOIN multisigs m ON m.id = s.multisig_id
				 JOIN users u ON u.id = s.owner_id
				 WHERE s.shared_with_id = ?
				 ORDER BY m.created_at DESC, m.id DESC`
			)
			.all(userId) as {
			multisig_id: number;
			name: string;
			threshold: number;
			role: string;
			owner_id: number;
			owner_name: string;
		}[]
	).map((r) => ({
		multisigId: r.multisig_id,
		name: r.name,
		threshold: r.threshold,
		role: r.role as ShareRole,
		ownerId: r.owner_id,
		ownerName: r.owner_name
	}));
}

/** The caller's role on a wallet, or null if they neither own nor share it. */
export function multisigAccessRole(
	userId: number,
	multisigId: number
): 'owner' | ShareRole | null {
	const owned = db
		.prepare('SELECT 1 FROM multisigs WHERE id = ? AND user_id = ?')
		.get(multisigId, userId);
	if (owned) return 'owner';
	const share = db
		.prepare('SELECT role FROM multisig_shares WHERE multisig_id = ? AND shared_with_id = ?')
		.get(multisigId, userId) as { role: string } | undefined;
	return share ? (share.role as ShareRole) : null;
}

/**
 * Redact a multisig's key list for a non-owner viewer: every key's `path` is
 * stripped EXCEPT the viewer's own assigned key(s). xpub and fingerprint are
 * never redacted (they're needed to tell keys apart and aren't secret). The
 * owner always sees everything. See the plan §6 (adapted from Bastion's
 * redactConfigForViewer).
 */
export function redactMultisigKeysForViewer(
	keys: MultisigKeyRow[],
	viewerId: number,
	ownerId: number
): MultisigKeyRow[] {
	if (viewerId === ownerId) return keys;
	return keys.map((k) =>
		k.assignedUserId === viewerId ? k : { ...k, path: '' }
	);
}
