// Address-level labels (cairn-nbsx). The DB half of "annotate an individual
// address" — mirrors the tx-label helpers in wallets.ts but keyed by address and
// spanning both wallet kinds via a wallet_kind discriminator. Pure persistence:
// callers (the API endpoints) enforce ownership before calling in.

import { db } from './db';

export type WalletKind = 'wallet' | 'multisig';

/** Same cap as tx labels (TX_LABEL_MAX) — one short human-readable annotation. */
export const ADDRESS_LABEL_MAX = 120;

/** Every address label for one wallet/multisig, keyed by address. */
export function getAddressLabels(kind: WalletKind, walletId: number): Record<string, string> {
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
	kind: WalletKind,
	walletId: number,
	address: string,
	label: string
): { address: string; label: string } {
	const trimmed = String(label ?? '')
		.trim()
		.slice(0, ADDRESS_LABEL_MAX);
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
