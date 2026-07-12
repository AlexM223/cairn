// Address book: saved recipients, scoped by userId (never by wallet — who you
// pay doesn't depend on which wallet you pay from). Every function takes the
// caller's locals.user.id and can't see another user's rows.

import { db } from './db';
import { isValidAddress } from './bitcoin/xpub';

export const ADDRESS_LABEL_MAX = 60;

export interface SavedAddress {
	id: number;
	label: string;
	address: string;
	createdAt: string;
	lastUsedAt: string | null;
}

export class AddressBookError extends Error {
	code: 'invalid_address' | 'invalid_label';

	constructor(message: string, code: 'invalid_address' | 'invalid_label') {
		super(message);
		this.name = 'AddressBookError';
		this.code = code;
	}
}

interface Row {
	id: number;
	label: string;
	address: string;
	created_at: string;
	last_used_at: string | null;
}

function toSavedAddress(row: Row): SavedAddress {
	return {
		id: row.id,
		label: row.label,
		address: row.address,
		createdAt: row.created_at,
		lastUsedAt: row.last_used_at
	};
}

const COLUMNS = 'id, label, address, created_at, last_used_at';

function getByAddress(userId: number, address: string): Row | null {
	const row = db
		.prepare(`SELECT ${COLUMNS} FROM saved_addresses WHERE user_id = ? AND address = ?`)
		.get(userId, address) as unknown as Row | undefined;
	return row ?? null;
}

/**
 * Every saved recipient for a user: most recently used first, then never-used
 * entries alphabetically by label.
 */
export function listSavedAddresses(userId: number): SavedAddress[] {
	const rows = db
		.prepare(
			`SELECT ${COLUMNS} FROM saved_addresses
			 WHERE user_id = ?
			 ORDER BY (last_used_at IS NULL) ASC, last_used_at DESC, label COLLATE NOCASE ASC, id ASC`
		)
		.all(userId) as unknown as Row[];
	return rows.map(toSavedAddress);
}

/**
 * Save a recipient, or touch one that's already saved.
 *
 * - New address: a trimmed 1–{@link ADDRESS_LABEL_MAX} character label is
 *   required; the address must pass the same validation the PSBT builder uses.
 * - Already saved (unique per user+address): bumps last_used_at, and renames
 *   the entry when a label is provided — omit `label` for a pure touch.
 *
 * Throws {@link AddressBookError} on bad input.
 */
export function saveAddress(
	userId: number,
	input: { address?: unknown; label?: unknown }
): { entry: SavedAddress; created: boolean } {
	const address = String(input.address ?? '').trim();
	if (!isValidAddress(address)) {
		throw new AddressBookError(
			"That's not a valid Bitcoin address — check for a typo or extra spaces.",
			'invalid_address'
		);
	}

	const hasLabel = input.label != null;
	const label = hasLabel ? String(input.label).trim() : '';
	if (hasLabel && (label.length < 1 || label.length > ADDRESS_LABEL_MAX)) {
		throw new AddressBookError(
			`Give this contact a name (1–${ADDRESS_LABEL_MAX} characters).`,
			'invalid_label'
		);
	}

	const existing = getByAddress(userId, address);
	if (existing) {
		db.prepare(
			`UPDATE saved_addresses
			 SET last_used_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), label = ?
			 WHERE id = ?`
		).run(hasLabel ? label : existing.label, existing.id);
		const row = getByAddress(userId, address);
		return { entry: toSavedAddress(row ?? existing), created: false };
	}

	if (!hasLabel) {
		throw new AddressBookError('Give this contact a name to save it.', 'invalid_label');
	}
	db.prepare('INSERT INTO saved_addresses (user_id, label, address) VALUES (?, ?, ?)').run(
		userId,
		label,
		address
	);
	const row = getByAddress(userId, address);
	if (!row) throw new Error('Saved address insert failed');
	return { entry: toSavedAddress(row), created: true };
}

/** Remove a saved recipient. False when it doesn't exist or isn't the caller's. */
export function deleteSavedAddress(userId: number, id: number): boolean {
	const res = db.prepare('DELETE FROM saved_addresses WHERE id = ? AND user_id = ?').run(id, userId);
	return Number(res.changes) > 0;
}
