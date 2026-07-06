// Collaborative-custody sign-session roster (see docs/COLLABORATIVE-CUSTODY-PLAN.md
// §4). The roster for one multisig_transactions row records which users are
// expected to contribute a signature. It is FROZEN at transaction-creation time —
// a later share/key change never rewrites an in-flight roster.
//
// has_signed on a roster row is ADVISORY (a UI/notification convenience): the
// authoritative signature state always comes from multisigPsbtProgress() reading
// the real PSBT bytes. reconcileRoster() derives has_signed from that truth.
//
// This is also where the plan fixes Bastion's confirmed live bug: notify EVERY
// roster member except the creator immediately at creation (not deferred until
// someone else signs), and again on each subsequent signature.

import { db } from './db';
import { notify } from './notifications';
import { childLogger } from './logger';
import type { MultisigRow } from './wallets/multisig';
import type { SavedMultisigTransaction } from './multisigTransactions';
import type { MultisigSigningProgress } from './bitcoin/multisigPsbt';

const log = childLogger('multisig:roster');

interface RosterRow {
	user_id: number;
	assigned_key_ids: string;
	has_signed: number;
}

/**
 * The distinct users expected to sign this multisig's transactions: the owner
 * (always, even holding only unassigned keys) plus every user any key is
 * assigned to. Returns a map of userId → the multisig_keys.id list attributed to
 * them (owner gets [] when they hold no explicitly-assigned key — they sign the
 * "remaining" unassigned keys).
 */
function computeRoster(multisig: MultisigRow): Map<number, number[]> {
	const roster = new Map<number, number[]>();
	roster.set(multisig.userId, []); // owner is always a member
	for (const key of multisig.keys) {
		const uid = key.assignedUserId ?? null;
		if (uid == null) continue;
		const list = roster.get(uid) ?? [];
		list.push(key.id);
		roster.set(uid, list);
	}
	return roster;
}

/**
 * Freeze the roster for a freshly-created draft, then notify every member except
 * the creator that their signature is wanted. Best-effort: a failure here must
 * never break draft creation (mirrors recordActivity's contract).
 */
export function freezeRosterAndNotify(
	multisig: MultisigRow,
	tx: SavedMultisigTransaction,
	creatorId: number
): void {
	try {
		const roster = computeRoster(multisig);
		const insert = db.prepare(
			`INSERT INTO multisig_transaction_signers (transaction_id, user_id, assigned_key_ids)
			 VALUES (?, ?, ?)
			 ON CONFLICT (transaction_id, user_id) DO NOTHING`
		);
		for (const [userId, keyIds] of roster) {
			insert.run(tx.id, userId, JSON.stringify(keyIds));
		}
		notifyRoster(multisig, tx, roster, creatorId, 0, multisig.threshold);
	} catch (e) {
		log.error({ err: e, txId: tx.id }, 'freezeRosterAndNotify failed');
	}
}

/**
 * Whether a user is on a transaction's frozen roster — the per-transaction gate
 * for attaching a signature (see the plan §4). Being a wallet-level cosigner is
 * necessary but not sufficient: a user added to multisig_shares AFTER this
 * transaction's roster was frozen is deliberately not on it, symmetric with the
 * revoke case (a later share change never rewrites an in-flight roster).
 */
export function isRosterMember(txId: number, userId: number): boolean {
	return !!db
		.prepare('SELECT 1 FROM multisig_transaction_signers WHERE transaction_id = ? AND user_id = ?')
		.get(txId, userId);
}

/** Notify every roster member except `exceptId` that a signature is wanted. */
function notifyRoster(
	multisig: MultisigRow,
	tx: SavedMultisigTransaction,
	roster: Map<number, number[]>,
	exceptId: number,
	collected: number,
	required: number
): void {
	for (const userId of roster.keys()) {
		if (userId === exceptId) continue;
		notify({
			type: 'sign_session_waiting',
			userId,
			level: 'info',
			title: 'Signature requested',
			body: `A transaction from “${multisig.name}” is waiting for your signature.`,
			detail: { multisigId: multisig.id, txId: tx.id, collected, required },
			link: `/wallets/multisig/${multisig.id}/send?tx=${tx.id}`
		});
	}
}

/** Map each stored key to whether the current PSBT carries its signature, by
 *  exact fingerprint+path attribution (the same authority broadcast uses). */
function signedKeyIds(multisig: MultisigRow, progress: MultisigSigningProgress): Set<number> {
	const signed = new Set<number>();
	for (const key of multisig.keys) {
		const hit = progress.keys.find(
			(k) => k.fingerprint.toLowerCase() === key.fingerprint.toLowerCase() && k.path === key.path
		);
		if (hit?.signed) signed.add(key.id);
	}
	return signed;
}

export interface RosterStatus {
	/** Roster user ids whose expected signature(s) are present. */
	signedBy: number[];
	/** Roster user ids still owed a signature. */
	waitingOn: number[];
}

/**
 * Reconcile advisory has_signed against the real PSBT progress and return the
 * signed/waiting split. Owner-with-no-assigned-keys is credited the "remaining"
 * unassigned keys, so it doesn't show as perpetually waiting. Never throws.
 */
export function reconcileRoster(
	multisig: MultisigRow,
	tx: SavedMultisigTransaction,
	progress: MultisigSigningProgress | null
): RosterStatus {
	const rows = db
		.prepare(
			'SELECT user_id, assigned_key_ids, has_signed FROM multisig_transaction_signers WHERE transaction_id = ?'
		)
		.all(tx.id) as unknown as RosterRow[];

	// Keys explicitly claimed by a non-owner roster member — everything else is
	// the owner's "remaining" set.
	const claimed = new Set<number>();
	for (const r of rows) {
		if (r.user_id === multisig.userId) continue;
		for (const id of parseIds(r.assigned_key_ids)) claimed.add(id);
	}

	const signed = progress ? signedKeyIds(multisig, progress) : new Set<number>();
	const allComplete = progress?.complete === true;

	const signedBy: number[] = [];
	const waitingOn: number[] = [];
	const update = db.prepare(
		"UPDATE multisig_transaction_signers SET has_signed = ?, signed_at = CASE WHEN ? = 1 THEN strftime('%Y-%m-%dT%H:%M:%fZ','now') ELSE signed_at END WHERE transaction_id = ? AND user_id = ?"
	);

	for (const r of rows) {
		let keyIds = parseIds(r.assigned_key_ids);
		// Owner fallback: attribute the unclaimed keys to the owner.
		if (r.user_id === multisig.userId && keyIds.length === 0) {
			keyIds = multisig.keys.map((k) => k.id).filter((id) => !claimed.has(id));
		}
		const done =
			allComplete || (keyIds.length > 0 && keyIds.every((id) => signed.has(id)));
		try {
			update.run(done ? 1 : 0, done ? 1 : 0, tx.id, r.user_id);
		} catch (e) {
			log.warn({ err: e, txId: tx.id, userId: r.user_id }, 'roster reconcile update failed');
		}
		(done ? signedBy : waitingOn).push(r.user_id);
	}

	return { signedBy, waitingOn };
}

/**
 * After a signature merges in, reconcile the roster and notify everyone still
 * waiting with updated progress. Best-effort.
 */
export function notifyRosterProgress(
	multisig: MultisigRow,
	tx: SavedMultisigTransaction,
	progress: MultisigSigningProgress | null
): RosterStatus {
	const status = reconcileRoster(multisig, tx, progress);
	try {
		if (!progress?.complete && status.waitingOn.length) {
			const rosterMap = new Map<number, number[]>(status.waitingOn.map((id) => [id, []]));
			notifyRoster(
				multisig,
				tx,
				rosterMap,
				-1,
				progress?.collected ?? 0,
				progress?.required ?? multisig.threshold
			);
		}
	} catch (e) {
		log.error({ err: e, txId: tx.id }, 'notifyRosterProgress failed');
	}
	return status;
}

export interface RosterMember {
	userId: number;
	displayName: string;
	isOwner: boolean;
	assignedKeyIds: number[];
	hasSigned: boolean;
}

/**
 * The roster for a transaction with member display names and reconciled signing
 * state — what the sign-session view renders. Reconciles against the live PSBT
 * progress first so has_signed can never lie.
 */
export function getRoster(
	multisig: MultisigRow,
	tx: SavedMultisigTransaction,
	progress: MultisigSigningProgress | null
): RosterMember[] {
	reconcileRoster(multisig, tx, progress);
	const rows = db
		.prepare(
			`SELECT s.user_id AS user_id, s.assigned_key_ids AS assigned_key_ids, s.has_signed AS has_signed,
			        u.display_name AS display_name
			 FROM multisig_transaction_signers s JOIN users u ON u.id = s.user_id
			 WHERE s.transaction_id = ?
			 ORDER BY (s.user_id = ?) DESC, u.display_name COLLATE NOCASE ASC`
		)
		.all(tx.id, multisig.userId) as {
		user_id: number;
		assigned_key_ids: string;
		has_signed: number;
		display_name: string;
	}[];
	return rows.map((r) => ({
		userId: r.user_id,
		displayName: r.display_name,
		isOwner: r.user_id === multisig.userId,
		assignedKeyIds: parseIds(r.assigned_key_ids),
		hasSigned: r.has_signed === 1
	}));
}

function parseIds(raw: string): number[] {
	try {
		const parsed = JSON.parse(raw);
		return Array.isArray(parsed) ? parsed.map(Number).filter(Number.isInteger) : [];
	} catch {
		return [];
	}
}
