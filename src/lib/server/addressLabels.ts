// Address-level labels (cairn-nbsx). The DB half of "annotate an individual
// address" — mirrors the tx-label helpers in wallets.ts but keyed by address and
// spanning both wallet kinds via a wallet_kind discriminator. Routes enforce
// access first, but read/write functions RE-VERIFY it internally
// (cairn-o1dp.3) — the table has no user_id column, so without this a future
// route that forgot its gate would leak labels wallet-wide with no second line
// of defense (contrast saved_addresses, which is user-scoped at the query level).

import { db } from './db';
import { containsNulByte, TextInputError } from './textGuard';

export type WalletKind = 'wallet' | 'multisig';

/** Same cap as tx labels (TX_LABEL_MAX) — one short human-readable annotation. */
export const ADDRESS_LABEL_MAX = 120;

/** Thrown when the internal access re-check fails — with correctly-gated
 *  routes this never fires; it exists to turn a future missing gate into a
 *  loud error instead of a silent cross-user leak. */
export class LabelAccessError extends Error {}

/** Single-sig: owner only. Multisig: any participant reads (shared
 *  annotations are viewer-visible by design), owner/cosigner writes —
 *  matching the route-level tiers (cairn-o1dp.4). */
function assertLabelAccess(
	userId: number,
	kind: WalletKind,
	walletId: number,
	access: 'read' | 'write'
): void {
	let ok: unknown;
	if (kind === 'wallet') {
		ok = db.prepare('SELECT 1 FROM wallets WHERE id = ? AND user_id = ?').get(walletId, userId);
	} else {
		const roleClause = access === 'write' ? " AND s.role = 'cosigner'" : '';
		ok = db
			.prepare(
				`SELECT 1 FROM multisigs m
				 WHERE m.id = ?
				   AND (m.user_id = ?
				        OR EXISTS (SELECT 1 FROM multisig_shares s
				                   WHERE s.multisig_id = m.id AND s.shared_with_id = ?${roleClause}))`
			)
			.get(walletId, userId, userId);
	}
	if (!ok) {
		throw new LabelAccessError(`No ${access} access to ${kind} ${walletId} for user ${userId}.`);
	}
}

/** Every address label for one wallet/multisig, keyed by address. */
export function getAddressLabels(
	userId: number,
	kind: WalletKind,
	walletId: number
): Record<string, string> {
	assertLabelAccess(userId, kind, walletId, 'read');
	const rows = db
		.prepare('SELECT address, label FROM address_labels WHERE wallet_kind = ? AND wallet_id = ?')
		.all(kind, walletId) as { address: string; label: string }[];
	const out: Record<string, string> = {};
	for (const r of rows) out[r.address] = r.label;
	return out;
}

/**
 * Upsert one address label. A trimmed-empty label clears it (returns label: '').
 * The label is trimmed and capped at ADDRESS_LABEL_MAX. Returns the stored value.
 */
export function setAddressLabel(
	userId: number,
	kind: WalletKind,
	walletId: number,
	address: string,
	label: string
): { address: string; label: string } {
	assertLabelAccess(userId, kind, walletId, 'write');
	const trimmed = String(label ?? '')
		.trim()
		.slice(0, ADDRESS_LABEL_MAX);
	// Reject an embedded NUL rather than let node:sqlite silently truncate the
	// label at it on write (cairn-y73r/cairn-x5m9) — see textGuard.ts.
	if (containsNulByte(trimmed)) {
		throw new TextInputError(
			'Address label contains a NUL character (U+0000), which cannot be stored. Remove it and try again.'
		);
	}
	if (!trimmed) {
		db.prepare(
			'DELETE FROM address_labels WHERE wallet_kind = ? AND wallet_id = ? AND address = ?'
		).run(kind, walletId, address);
		return { address, label: '' };
	}
	db.prepare(
		`INSERT INTO address_labels (wallet_kind, wallet_id, address, label) VALUES (?, ?, ?, ?)
		 ON CONFLICT (wallet_kind, wallet_id, address) DO UPDATE SET label = excluded.label`
	).run(kind, walletId, address, trimmed);
	return { address, label: trimmed };
}

/** Drop every address label for a wallet/multisig (called on its deletion, since
 *  there's no FK to cascade — the id isn't unique across the two kinds). */
export function deleteAddressLabels(kind: WalletKind, walletId: number): void {
	db.prepare('DELETE FROM address_labels WHERE wallet_kind = ? AND wallet_id = ?').run(
		kind,
		walletId
	);
}
