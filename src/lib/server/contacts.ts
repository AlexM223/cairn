// Contacts: the friends-only social graph collaborative custody sits on top of
// (see docs/COLLABORATIVE-CUSTODY-PLAN.md §5). A multisig wallet can only be
// shared with an ACCEPTED contact, so this is the gate that keeps wallet sharing
// friends-only rather than arbitrary-user-id sharing.
//
// Contacts are display-name-revealing BY DESIGN — you should know who you're
// friending. That's the opposite of Cairn's identity-hiding features (recovery
// phrases etc.), and the UI copy says so explicitly.
//
// Anti-enumeration: requestContact returns the same success shape whether or not
// the target email belongs to a real account, so a caller can't probe which
// emails have accounts here.

import { db } from './db';
import { revokeAllSharesBetween } from './multisigShares';

export class ContactError extends Error {
	code: 'self' | 'invalid_email';

	constructor(message: string, code: 'self' | 'invalid_email') {
		super(message);
		this.name = 'ContactError';
		this.code = code;
	}
}

/** The other party in a contact relationship, from the caller's point of view. */
export interface ContactSummary {
	/** contacts.id — the handle used to respond to / remove this relationship. */
	id: number;
	/** The OTHER user's id (never the caller's). */
	userId: number;
	displayName: string;
	email: string;
	createdAt: string;
}

export interface ContactList {
	/** Accepted both ways — these are the people you can share a wallet with. */
	friends: ContactSummary[];
	/** Pending requests where someone else wants to add YOU (you accept/decline). */
	requestsReceived: ContactSummary[];
	/** Pending requests YOU sent that haven't been accepted yet (you can cancel). */
	requestsSent: ContactSummary[];
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface UserRow {
	id: number;
	email: string;
	display_name: string;
}

function findUserByEmail(email: string): UserRow | null {
	const row = db
		.prepare('SELECT id, email, display_name FROM users WHERE email = ? COLLATE NOCASE')
		.get(email) as UserRow | undefined;
	return row ?? null;
}

/**
 * Send a contact request to the account with `email`, or — if that account
 * already has a pending request out to the caller — accept it (a mutual request
 * from both sides IS the acceptance). Idempotent: re-requesting an existing
 * pending/accepted relationship is a no-op.
 *
 * Anti-enumeration: an unknown email and a freshly-created request return the
 * SAME success (void). The only distinguishable outcome is requesting your own
 * email, which you already know is yours, so revealing it leaks nothing.
 */
export function requestContact(userId: number, rawEmail: string): void {
	const email = String(rawEmail ?? '').trim().toLowerCase();
	if (!EMAIL_RE.test(email)) {
		throw new ContactError('Enter a valid email address.', 'invalid_email');
	}

	const target = findUserByEmail(email);
	// Unknown account: silently succeed — indistinguishable from "request sent".
	if (!target) return;
	if (target.id === userId) {
		throw new ContactError('That is your own email address.', 'self');
	}

	// Already related in either direction? Auto-accept a reciprocal request,
	// otherwise leave the existing row untouched (idempotent).
	const reciprocal = db
		.prepare(
			`SELECT id, status FROM contacts WHERE user_id = ? AND contact_user_id = ?`
		)
		.get(target.id, userId) as { id: number; status: string } | undefined;
	if (reciprocal) {
		if (reciprocal.status === 'pending') {
			db.prepare(
				`UPDATE contacts SET status = 'accepted', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`
			).run(reciprocal.id);
		}
		return;
	}

	const mine = db
		.prepare(`SELECT id FROM contacts WHERE user_id = ? AND contact_user_id = ?`)
		.get(userId, target.id) as { id: number } | undefined;
	if (mine) return; // already requested (pending or accepted) — no-op

	db.prepare(
		`INSERT INTO contacts (user_id, contact_user_id, status) VALUES (?, ?, 'pending')`
	).run(userId, target.id);
}

/**
 * Respond to a pending request addressed to the caller. Accept flips it to
 * 'accepted'; decline deletes the row. Returns false when no such incoming
 * pending request exists (already handled, or not the caller's to answer).
 */
export function respondToContact(userId: number, contactId: number, accept: boolean): boolean {
	const row = db
		.prepare(
			`SELECT id FROM contacts WHERE id = ? AND contact_user_id = ? AND status = 'pending'`
		)
		.get(contactId, userId) as { id: number } | undefined;
	if (!row) return false;

	if (accept) {
		db.prepare(
			`UPDATE contacts SET status = 'accepted', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`
		).run(contactId);
	} else {
		db.prepare('DELETE FROM contacts WHERE id = ?').run(contactId);
	}
	return true;
}

/**
 * Remove a contact relationship the caller is part of — one function for
 * cancel (a request you sent), decline, and unfriend (an accepted contact),
 * whether the caller is the requester or the target. Returns false when the
 * row doesn't exist or doesn't involve the caller.
 */
export function removeContact(userId: number, contactId: number): boolean {
	const row = db
		.prepare(
			`SELECT user_id, contact_user_id FROM contacts
			  WHERE id = ? AND (user_id = ? OR contact_user_id = ?)`
		)
		.get(contactId, userId, userId) as
		| { user_id: number; contact_user_id: number | null }
		| undefined;
	if (!row) return false;

	db.prepare('DELETE FROM contacts WHERE id = ?').run(contactId);

	// Ending the contact relationship also ends any multisig access it enabled:
	// sharing requires an accepted contact, so revoke shares in BOTH directions
	// between the two users (cairn-2oex). A pending, not-yet-linked contact
	// (contact_user_id NULL) can have no shares.
	if (row.contact_user_id != null) {
		revokeAllSharesBetween(row.user_id, row.contact_user_id);
	}
	return true;
}

/** True when the two users are ACCEPTED contacts (either direction). */
export function areContacts(userIdA: number, userIdB: number): boolean {
	return !!db
		.prepare(
			`SELECT 1 FROM contacts
			 WHERE status = 'accepted'
			   AND ((user_id = ? AND contact_user_id = ?) OR (user_id = ? AND contact_user_id = ?))
			 LIMIT 1`
		)
		.get(userIdA, userIdB, userIdB, userIdA);
}

interface JoinedRow {
	id: number;
	other_id: number;
	display_name: string;
	email: string;
	created_at: string;
}

function toSummary(r: JoinedRow): ContactSummary {
	return {
		id: r.id,
		userId: r.other_id,
		displayName: r.display_name,
		email: r.email,
		createdAt: r.created_at
	};
}

/**
 * The caller's contacts split for the UI: accepted friends, incoming pending
 * requests (to accept/decline), and outgoing pending requests (to cancel).
 */
export function listContacts(userId: number): ContactList {
	// Accepted, either direction — the "other" user is whichever side isn't me.
	const friends = (
		db
			.prepare(
				`SELECT c.id AS id,
				        CASE WHEN c.user_id = ? THEN c.contact_user_id ELSE c.user_id END AS other_id,
				        u.display_name AS display_name, u.email AS email, c.created_at AS created_at
				 FROM contacts c
				 JOIN users u ON u.id = CASE WHEN c.user_id = ? THEN c.contact_user_id ELSE c.user_id END
				 WHERE c.status = 'accepted' AND (c.user_id = ? OR c.contact_user_id = ?)
				 ORDER BY u.display_name COLLATE NOCASE ASC, c.id ASC`
			)
			.all(userId, userId, userId, userId) as unknown as JoinedRow[]
	).map(toSummary);

	const requestsReceived = (
		db
			.prepare(
				`SELECT c.id AS id, c.user_id AS other_id, u.display_name AS display_name,
				        u.email AS email, c.created_at AS created_at
				 FROM contacts c JOIN users u ON u.id = c.user_id
				 WHERE c.status = 'pending' AND c.contact_user_id = ?
				 ORDER BY c.created_at DESC, c.id DESC`
			)
			.all(userId) as unknown as JoinedRow[]
	).map(toSummary);

	const requestsSent = (
		db
			.prepare(
				`SELECT c.id AS id, c.contact_user_id AS other_id, u.display_name AS display_name,
				        u.email AS email, c.created_at AS created_at
				 FROM contacts c JOIN users u ON u.id = c.contact_user_id
				 WHERE c.status = 'pending' AND c.user_id = ?
				 ORDER BY c.created_at DESC, c.id DESC`
			)
			.all(userId) as unknown as JoinedRow[]
	).map(toSummary);

	return { friends, requestsReceived, requestsSent };
}
