// Watch-only wallet service layer. Every function is scoped by userId —
// callers pass locals.user.id and never see another user's rows.

import { db } from './db';
import { parseXpub, deriveAddress } from './bitcoin/xpub';
import {
	scanWallet,
	invalidateWalletCache,
	findNextUnusedIndex,
	type WalletScanResult
} from './bitcoin/walletScan';
import type { ScriptType, WalletSummary } from '$lib/types';

const GAP_LIMIT = 20;

export interface WalletRow {
	id: number;
	user_id: number;
	name: string;
	type: 'xpub';
	xpub: string;
	script_type: ScriptType;
	receive_cursor: number;
	created_at: string;
}

// ---------------------------------------------------------------- helpers

/** Map raw parseXpub errors to something a person can act on. */
export function friendlyXpubError(e: unknown): string {
	const msg = e instanceof Error ? e.message : String(e);
	if (/private extended key/i.test(msg)) return msg; // already explains itself
	if (/testnet/i.test(msg)) return msg;
	if (/empty/i.test(msg)) return 'Paste an extended public key (xpub, ypub or zpub).';
	if (/checksum/i.test(msg))
		return 'That key has a bad checksum — double-check you copied the whole string.';
	if (/base58|length|prefix|no public key/i.test(msg))
		return "That doesn't look like an extended public key. Paste the full xpub, ypub or zpub string.";
	return `Could not read that key: ${msg}`;
}

/** Latest activity from a scan: newest confirmed tx time, or "now" if anything is pending. */
function lastActivityOf(scan: WalletScanResult): number | null {
	let latest: number | null = null;
	let pending = false;
	for (const tx of scan.txs) {
		if (tx.height <= 0) pending = true;
		else if (tx.time != null) latest = Math.max(latest ?? 0, tx.time);
	}
	if (pending) return Math.floor(Date.now() / 1000);
	return latest;
}

export function toWalletSummary(row: WalletRow, scan?: WalletScanResult): WalletSummary {
	return {
		id: row.id,
		name: row.name,
		type: 'xpub',
		scriptType: row.script_type,
		xpub: row.xpub,
		createdAt: row.created_at,
		balance: scan?.confirmed ?? 0,
		unconfirmed: scan?.unconfirmed ?? 0,
		lastActivity: scan ? lastActivityOf(scan) : null
	};
}

// ---------------------------------------------------------------- queries

export function getWallet(userId: number, id: number): WalletRow | null {
	const row = db
		.prepare('SELECT * FROM wallets WHERE id = ? AND user_id = ?')
		.get(id, userId) as unknown as WalletRow | undefined;
	return row ?? null;
}

/**
 * All wallets for a user, with live balances from (cached) scans.
 * A scan failure never throws: that wallet comes back with zeroed balances
 * and its error message lands in `errors[walletId]`.
 */
export async function listWallets(
	userId: number
): Promise<{ wallets: WalletSummary[]; errors: Record<number, string> }> {
	const rows = db
		.prepare('SELECT * FROM wallets WHERE user_id = ? ORDER BY created_at ASC, id ASC')
		.all(userId) as unknown as WalletRow[];

	const errors: Record<number, string> = {};
	const wallets = await Promise.all(
		rows.map(async (row) => {
			try {
				const scan = await scanWallet(row.xpub);
				return toWalletSummary(row, scan);
			} catch (e) {
				errors[row.id] = e instanceof Error ? e.message : 'Wallet scan failed';
				return toWalletSummary(row);
			}
		})
	);
	return { wallets, errors };
}

export function createWallet(
	userId: number,
	input: { name?: string; xpub?: string }
): WalletSummary {
	const xpub = String(input.xpub ?? '').trim();
	let scriptType: ScriptType;
	try {
		scriptType = parseXpub(xpub).scriptType;
	} catch (e) {
		throw new Error(friendlyXpubError(e));
	}

	let name = String(input.name ?? '').trim().slice(0, 64);
	if (!name) {
		const { n } = db
			.prepare('SELECT COUNT(*) AS n FROM wallets WHERE user_id = ?')
			.get(userId) as { n: number };
		name = `Wallet ${n + 1}`;
	}

	try {
		const res = db
			.prepare(
				'INSERT INTO wallets (user_id, name, type, xpub, script_type) VALUES (?, ?, ?, ?, ?)'
			)
			.run(userId, name, 'xpub', xpub, scriptType);
		const row = getWallet(userId, Number(res.lastInsertRowid));
		if (!row) throw new Error('Wallet insert failed');
		return toWalletSummary(row);
	} catch (e) {
		if (e instanceof Error && /UNIQUE/i.test(e.message)) {
			throw new Error('You already imported this key.');
		}
		throw e;
	}
}

export function deleteWallet(userId: number, id: number): boolean {
	const row = getWallet(userId, id);
	if (!row) return false;
	db.prepare('DELETE FROM wallets WHERE id = ? AND user_id = ?').run(id, userId);
	invalidateWalletCache(row.xpub);
	return true;
}

/**
 * Wallet row plus a full scan. Returns null when the wallet doesn't exist
 * (or isn't owned); throws Error with cause 'unreachable' when the scan
 * fails so pages can render an error state around the wallet shell.
 */
export async function getWalletDetail(
	userId: number,
	id: number
): Promise<{ wallet: WalletRow; scan: WalletScanResult } | null> {
	const wallet = getWallet(userId, id);
	if (!wallet) return null;
	try {
		const scan = await scanWallet(wallet.xpub);
		return { wallet, scan };
	} catch (e) {
		throw new Error(e instanceof Error ? e.message : 'Wallet scan failed', {
			cause: 'unreachable'
		});
	}
}

// ------------------------------------------------------- receive addresses

function clampToGap(idx: number, nextUnused: number): number {
	// Never hand out an address beyond the gap-limit window, or wallets that
	// follow BIP44 discovery would miss funds sent to it.
	return Math.min(idx, nextUnused + GAP_LIMIT - 1);
}

/**
 * Hand out the next unused receive address and advance the cursor.
 * `afterIndex` (optional) requests an address strictly after the one the
 * caller is already showing, so repeated clicks always swap to a fresh one.
 * Cycles within the gap window — the index never exceeds nextUnused + 19.
 */
export async function nextReceiveAddress(
	userId: number,
	id: number,
	afterIndex?: number
): Promise<{ address: string; path: string; index: number } | null> {
	const wallet = getWallet(userId, id);
	if (!wallet) return null;

	const nextUnused = await findNextUnusedIndex(wallet.xpub, 0);
	const after = Number.isInteger(afterIndex) ? (afterIndex as number) : -1;
	const idx = clampToGap(Math.max(nextUnused, wallet.receive_cursor, after + 1), nextUnused);
	const { address, path } = deriveAddress(parseXpub(wallet.xpub), 0, idx);

	db.prepare('UPDATE wallets SET receive_cursor = ? WHERE id = ? AND user_id = ?').run(
		Math.min(idx + 1, nextUnused + GAP_LIMIT),
		id,
		userId
	);
	return { address, path, index: idx };
}

/**
 * The receive address currently "on display" — the most recently handed-out
 * index (cursor − 1) or the next unused one, whichever is further along.
 * Read-only: never advances the cursor.
 */
export async function peekReceiveAddress(
	wallet: WalletRow
): Promise<{ address: string; path: string; index: number }> {
	const nextUnused = await findNextUnusedIndex(wallet.xpub, 0);
	const idx = clampToGap(Math.max(nextUnused, wallet.receive_cursor - 1), nextUnused);
	const { address, path } = deriveAddress(parseXpub(wallet.xpub), 0, idx);
	return { address, path, index: idx };
}
