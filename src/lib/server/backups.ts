// Wallet-config backup status, tracked server-side. A wallet's configuration —
// its public keys and settings — is what's needed to find its bitcoin and, for
// multisig, to RECONSTRUCT the wallet at all; losing it (with Cairn's data
// gone) can mean permanently losing access to funds. So we treat "has the user
// downloaded this wallet's backup?" as first-class state, not a client-only
// flag. See db.ts (wallet_backups) and the creation wizards / persistent banner.

import { db } from './db';
import type { WalletKind } from '$lib/types';

/** A wallet that still has no config backup on record. */
export interface UnbackedWallet {
	kind: WalletKind;
	id: number;
	name: string;
	/** Link to this wallet's detail page (where its backup can be downloaded). */
	href: string;
}

/** Record that a wallet's config backup has been downloaded (idempotent). */
export function markBackedUp(userId: number, kind: WalletKind, id: number): void {
	db.prepare(
		`INSERT INTO wallet_backups (user_id, wallet_kind, wallet_id) VALUES (?, ?, ?)
		 ON CONFLICT (wallet_kind, wallet_id) DO NOTHING`
	).run(userId, kind, id);
}

/** Whether a wallet's config backup has been downloaded. */
export function isBackedUp(kind: WalletKind, id: number): boolean {
	return !!db
		.prepare('SELECT 1 FROM wallet_backups WHERE wallet_kind = ? AND wallet_id = ?')
		.get(kind, id);
}

/**
 * Every wallet (single-sig and multisig) the user owns that has no backup on
 * record — powers the persistent "back up your wallets" banner. Cheap: two
 * anti-joins against the small wallet_backups table.
 */
export function listUnbackedWallets(userId: number): UnbackedWallet[] {
	const singles = db
		.prepare(
			`SELECT w.id AS id, w.name AS name
			 FROM wallets w
			 WHERE w.user_id = ?
			   AND NOT EXISTS (
			     SELECT 1 FROM wallet_backups b
			     WHERE b.wallet_kind = 'wallet' AND b.wallet_id = w.id
			   )
			 ORDER BY w.created_at ASC, w.id ASC`
		)
		.all(userId) as { id: number; name: string }[];

	const multis = db
		.prepare(
			`SELECT m.id AS id, m.name AS name
			 FROM multisigs m
			 WHERE m.user_id = ?
			   AND NOT EXISTS (
			     SELECT 1 FROM wallet_backups b
			     WHERE b.wallet_kind = 'multisig' AND b.wallet_id = m.id
			   )
			 ORDER BY m.created_at ASC, m.id ASC`
		)
		.all(userId) as { id: number; name: string }[];

	return [
		...singles.map((w): UnbackedWallet => ({ kind: 'wallet', id: w.id, name: w.name, href: `/wallets/${w.id}` })),
		...multis.map((m): UnbackedWallet => ({
			kind: 'multisig',
			id: m.id,
			name: m.name,
			href: `/wallets/multisig/${m.id}`
		}))
	];
}
