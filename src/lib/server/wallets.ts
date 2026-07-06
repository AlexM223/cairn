// Single-sig wallet service layer. A wallet is one xpub: Cairn holds only the
// public key (it can never spend on its own), but the wallet is a full wallet —
// the user signs on their own device. Every function is scoped by userId —
// callers pass locals.user.id and never see another user's rows.

import { db } from './db';
import { parseXpub, deriveAddress } from './bitcoin/xpub';
import {
	scanWallet,
	invalidateWalletCache,
	findNextUnusedIndex,
	type WalletScanResult
} from './bitcoin/walletScan';
import type { ScriptType, WalletDeviceType, WalletSummary } from '$lib/types';

const GAP_LIMIT = 20;

/** Device types a wallet's key can be routed to when signing. */
const WALLET_DEVICE_TYPES: readonly WalletDeviceType[] = [
	'trezor',
	'ledger',
	'coldcard',
	'qr',
	'file'
];

/** Coerce arbitrary input to a known device type, or null when unrecognized. */
export function normalizeDeviceType(input: unknown): WalletDeviceType | null {
	const v = String(input ?? '').trim().toLowerCase();
	return (WALLET_DEVICE_TYPES as readonly string[]).includes(v)
		? (v as WalletDeviceType)
		: null;
}

export interface WalletRow {
	id: number;
	user_id: number;
	name: string;
	type: 'xpub';
	xpub: string;
	script_type: ScriptType;
	device_type: WalletDeviceType | null;
	/** Key origin, embedded in PSBTs and the config backup; null until known. */
	master_fingerprint: string | null;
	derivation_path: string | null;
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
		deviceType: row.device_type ?? null,
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
	input: { name?: string; xpub?: string; deviceType?: unknown }
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

	// null (unspecified) is stored as-is — signing falls back to file/PSBT.
	const deviceType = normalizeDeviceType(input.deviceType);

	try {
		const res = db
			.prepare(
				'INSERT INTO wallets (user_id, name, type, xpub, script_type, device_type) VALUES (?, ?, ?, ?, ?, ?)'
			)
			.run(userId, name, 'xpub', xpub, scriptType, deviceType);
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

/**
 * Record (or clear) which signing device holds this wallet's key. Used when
 * the user associates a device during their first send. Returns the updated
 * summary, or null when the wallet doesn't exist or isn't owned by userId.
 */
export function setWalletDevice(
	userId: number,
	id: number,
	deviceType: unknown
): WalletSummary | null {
	const row = getWallet(userId, id);
	if (!row) return null;
	const normalized = normalizeDeviceType(deviceType);
	db.prepare('UPDATE wallets SET device_type = ? WHERE id = ? AND user_id = ?').run(
		normalized,
		id,
		userId
	);
	return toWalletSummary({ ...row, device_type: normalized });
}

export function deleteWallet(userId: number, id: number): boolean {
	const row = getWallet(userId, id);
	if (!row) return false;
	db.prepare('DELETE FROM wallets WHERE id = ? AND user_id = ?').run(id, userId);
	// notified_txids has no FK to wallets (cairn-zari), so it won't cascade —
	// clear this wallet's dedup rows explicitly to avoid orphans accumulating.
	db.prepare("DELETE FROM notified_txids WHERE wallet_kind = 'wallet' AND wallet_id = ?").run(id);
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

// ------------------------------------------------------------- tx labels

export const TX_LABEL_MAX = 120;

/**
 * All transaction labels for a wallet, keyed by txid.
 * Returns null when the wallet doesn't exist or isn't owned by userId.
 */
export function getLabels(userId: number, walletId: number): Record<string, string> | null {
	if (!getWallet(userId, walletId)) return null;
	const rows = db
		.prepare('SELECT txid, label FROM tx_labels WHERE wallet_id = ?')
		.all(walletId) as unknown as { txid: string; label: string }[];
	const labels: Record<string, string> = {};
	for (const row of rows) labels[row.txid] = row.label;
	return labels;
}

/**
 * Upsert a free-text label on a transaction in this wallet. The label is
 * trimmed and capped at TX_LABEL_MAX characters; an empty (or all-whitespace)
 * label clears any existing one. Returns the stored value, or null when the
 * wallet doesn't exist or isn't owned by userId.
 */
export function setLabel(
	userId: number,
	walletId: number,
	txid: string,
	label: string
): { txid: string; label: string } | null {
	if (!getWallet(userId, walletId)) return null;

	const trimmed = String(label ?? '').trim().slice(0, TX_LABEL_MAX);
	if (!trimmed) {
		db.prepare('DELETE FROM tx_labels WHERE wallet_id = ? AND txid = ?').run(walletId, txid);
		return { txid, label: '' };
	}
	db.prepare(
		`INSERT INTO tx_labels (wallet_id, txid, label) VALUES (?, ?, ?)
		 ON CONFLICT (wallet_id, txid) DO UPDATE SET label = excluded.label`
	).run(walletId, txid, trimmed);
	return { txid, label: trimmed };
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
