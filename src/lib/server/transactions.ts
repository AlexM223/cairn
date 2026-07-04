// Transaction lifecycle service: builds unsigned PSBTs from a wallet's live
// UTXO set and persists them through draft → awaiting-signature → completed.

import { base64 } from '@scure/base';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { db } from './db';
import { getChain } from './chain';
import { scanWallet, findNextUnusedIndex } from './bitcoin/walletScan';
import {
	constructPsbt,
	finalizePsbt,
	assertSameTransaction,
	PsbtMismatchError,
	DEFAULT_ORIGIN_PATH,
	PsbtError,
	type ConstructedPsbt,
	type SpendableUtxo
} from './bitcoin/psbt';
import { parseXpub, deriveAddress, addressToScripthash } from './bitcoin/xpub';
import type { ScriptType } from '$lib/types';

export type TxStatus = 'draft' | 'awaiting_signature' | 'completed';

export interface SavedTransaction {
	id: number;
	walletId: number;
	status: TxStatus;
	psbt: string;
	txid: string | null;
	recipient: string;
	amount: number;
	fee: number;
	feeRate: number;
	changeIndex: number | null;
	createdAt: string;
	updatedAt: string;
}

interface WalletRow {
	id: number;
	user_id: number;
	xpub: string;
	script_type: string;
	master_fingerprint: string | null;
	derivation_path: string | null;
}

function ownedWallet(userId: number, walletId: number): WalletRow | null {
	return (
		(db
			.prepare(
				'SELECT id, user_id, xpub, script_type, master_fingerprint, derivation_path FROM wallets WHERE id = ? AND user_id = ?'
			)
			.get(walletId, userId) as WalletRow | undefined) ?? null
	);
}

/** Live spendable UTXOs for a wallet, attributed to derivation indices. */
export async function getWalletUtxos(xpub: string): Promise<SpendableUtxo[]> {
	const chain = getChain();
	const scan = await scanWallet(xpub);
	const candidates = scan.addresses.filter((a) => a.used || a.balance > 0);

	const results = await Promise.all(
		candidates.map(async (addr) => {
			const unspent = await chain.electrum.listUnspent(addressToScripthash(addr.address));
			return unspent.map((u) => ({
				txid: u.tx_hash,
				vout: u.tx_pos,
				value: u.value,
				height: u.height,
				address: addr.address,
				chain: (addr.change ? 1 : 0) as 0 | 1,
				index: addr.index
			}));
		})
	);
	return results.flat();
}

export interface BuildDraftInput {
	recipient: string;
	amount: number | 'max';
	feeRate: number;
}

/**
 * Build an unsigned PSBT for a wallet and persist it as a draft.
 * Throws PsbtError with a user-presentable message on any construction issue.
 */
export async function buildDraft(
	userId: number,
	walletId: number,
	input: BuildDraftInput
): Promise<{ draft: SavedTransaction; details: ConstructedPsbt }> {
	const wallet = ownedWallet(userId, walletId);
	if (!wallet) throw new PsbtError('Wallet not found.', 'construction_failed');

	const scriptType = wallet.script_type as ScriptType;
	const utxos = await getWalletUtxos(wallet.xpub);

	// Change goes to the wallet's own change chain, next unused index.
	const parsed = parseXpub(wallet.xpub);
	const changeIndex = await findNextUnusedIndex(wallet.xpub, 1);
	const changeAddress = deriveAddress(parsed, 1, changeIndex).address;

	// Derivation info goes in only when the key's origin is actually known —
	// a guessed fingerprint would send hardware signers hunting for the
	// wrong key. The path may still default sensibly by script type.
	const origin = wallet.master_fingerprint
		? {
				fingerprint: wallet.master_fingerprint,
				path: wallet.derivation_path ?? DEFAULT_ORIGIN_PATH[scriptType]
			}
		: null;

	const details = await constructPsbt({
		xpub: wallet.xpub,
		utxos,
		recipient: input.recipient,
		amount: input.amount,
		feeRate: input.feeRate,
		changeAddress,
		changeIndex,
		origin,
		fetchRawTx: (txid) => getChain().getTxHex(txid)
	});

	const res = db
		.prepare(
			`INSERT INTO transactions (wallet_id, status, psbt, recipient, amount, fee, fee_rate, change_index)
			 VALUES (?, 'draft', ?, ?, ?, ?, ?, ?)`
		)
		.run(
			walletId,
			details.psbtBase64,
			details.recipient,
			details.amount,
			details.fee,
			details.feeRate,
			details.change?.index ?? null
		);

	const draft = getTransaction(userId, walletId, Number(res.lastInsertRowid));
	if (!draft) throw new PsbtError('Draft could not be saved.', 'construction_failed');
	return { draft, details };
}

function mapRow(r: Record<string, unknown>): SavedTransaction {
	return {
		id: r.id as number,
		walletId: r.wallet_id as number,
		status: r.status as TxStatus,
		psbt: r.psbt as string,
		txid: (r.txid as string | null) ?? null,
		recipient: r.recipient as string,
		amount: r.amount as number,
		fee: r.fee as number,
		feeRate: r.fee_rate as number,
		changeIndex: (r.change_index as number | null) ?? null,
		createdAt: r.created_at as string,
		updatedAt: r.updated_at as string
	};
}

export function listTransactions(userId: number, walletId: number): SavedTransaction[] | null {
	if (!ownedWallet(userId, walletId)) return null;
	// id DESC tiebreaks rows created within the same millisecond.
	const rows = db
		.prepare('SELECT * FROM transactions WHERE wallet_id = ? ORDER BY created_at DESC, id DESC')
		.all(walletId) as Record<string, unknown>[];
	return rows.map(mapRow);
}

export function getTransaction(
	userId: number,
	walletId: number,
	txId: number
): SavedTransaction | null {
	if (!ownedWallet(userId, walletId)) return null;
	const row = db
		.prepare('SELECT * FROM transactions WHERE id = ? AND wallet_id = ?')
		.get(txId, walletId) as Record<string, unknown> | undefined;
	return row ? mapRow(row) : null;
}

/** Advance lifecycle state; updates the stored PSBT when signatures arrive. */
export function updateTransaction(
	userId: number,
	walletId: number,
	txId: number,
	fields: { status?: TxStatus; psbt?: string; txid?: string }
): SavedTransaction | null {
	const existing = getTransaction(userId, walletId, txId);
	if (!existing) return null;

	db.prepare(
		`UPDATE transactions
		 SET status = COALESCE(?, status),
		     psbt = COALESCE(?, psbt),
		     txid = COALESCE(?, txid),
		     updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
		 WHERE id = ?`
	).run(fields.status ?? null, fields.psbt ?? null, fields.txid ?? null, txId);

	return getTransaction(userId, walletId, txId);
}

// -------------------------------------------------------- PSBT safety checks

const PSBT_MAGIC_HEX = '70736274ff'; // "psbt\xff"

function hasPsbtMagic(bytes: Uint8Array): boolean {
	return bytes.length > 5 && bytesToHex(bytes.slice(0, 5)) === PSBT_MAGIC_HEX;
}

/**
 * Accept a PSBT in any of the shapes signers hand back — base64 text, hex
 * text, or base64-of-a-text-file that itself contains base64/hex — and return
 * canonical base64 of the raw binary. Throws on anything that isn't a PSBT.
 */
export function normalizePsbt(input: string, depth = 0): string {
	const trimmed = input.trim();
	if (!trimmed) throw new Error('Empty PSBT');

	if (new RegExp(`^${PSBT_MAGIC_HEX}[0-9a-fA-F]*$`, 'i').test(trimmed)) {
		return base64.encode(hexToBytes(trimmed.toLowerCase()));
	}

	const bytes = base64.decode(trimmed); // throws on non-base64
	if (hasPsbtMagic(bytes)) return base64.encode(bytes);

	// A .psbt "file" that's actually text (base64/hex with a trailing newline)
	// arrives here as base64-encoded ASCII — unwrap one layer, once.
	if (depth === 0) {
		const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
		return normalizePsbt(text, 1);
	}
	throw new Error('Not a PSBT');
}

export class BroadcastError extends Error {
	constructor(
		message: string,
		public readonly code: 'not_found' | 'already_sent' | 'incomplete' | 'mismatch' | 'rejected'
	) {
		super(message);
		this.name = 'BroadcastError';
	}
}

/**
 * Finalize a saved transaction's (fully-signed) PSBT and broadcast it. Guards
 * against double-broadcast: a transaction already carrying a txid is refused.
 * On success the txid is recorded and the row moves to 'completed'.
 */
export async function broadcastTransaction(
	userId: number,
	walletId: number,
	txId: number,
	signedPsbt?: string
): Promise<{ txid: string; transaction: SavedTransaction }> {
	const tx = getTransaction(userId, walletId, txId);
	if (!tx) throw new BroadcastError('Transaction not found.', 'not_found');
	if (tx.status === 'completed' || tx.txid)
		throw new BroadcastError('This transaction has already been broadcast.', 'already_sent');

	let psbt = tx.psbt;
	if (signedPsbt?.trim()) {
		try {
			psbt = normalizePsbt(signedPsbt);
		} catch {
			throw new BroadcastError("That doesn't look like a valid PSBT.", 'incomplete');
		}
		// Never broadcast something other than what was reviewed and saved.
		try {
			assertSameTransaction(tx.psbt, psbt);
		} catch (e) {
			throw new BroadcastError(
				e instanceof PsbtMismatchError
					? e.message
					: 'The supplied PSBT describes a different transaction than this draft — refusing to broadcast it.',
				'mismatch'
			);
		}
	}

	let finalized: { rawHex: string; txid: string };
	try {
		finalized = finalizePsbt(psbt);
	} catch (e) {
		// finalize() throws when signatures are missing or malformed.
		throw new BroadcastError(
			e instanceof Error
				? `This PSBT isn't fully signed yet: ${e.message}`
				: 'This PSBT is not fully signed.',
			'incomplete'
		);
	}

	let broadcastTxid: string;
	try {
		broadcastTxid = await getChain().electrum.broadcast(finalized.rawHex);
	} catch (e) {
		// Surface the node's rejection reason in as-plain-as-possible language.
		const raw = e instanceof Error ? e.message : String(e);
		throw new BroadcastError(`The network rejected this transaction: ${raw}`, 'rejected');
	}

	const updated = updateTransaction(userId, walletId, txId, {
		status: 'completed',
		psbt,
		txid: broadcastTxid
	});
	return { txid: broadcastTxid, transaction: updated! };
}

export function deleteTransaction(userId: number, walletId: number, txId: number): boolean {
	if (!getTransaction(userId, walletId, txId)) return false;
	// Completed transactions are history — deleting them would erase the
	// record that a broadcast happened.
	const status = getTransaction(userId, walletId, txId)?.status;
	if (status === 'completed') return false;
	db.prepare('DELETE FROM transactions WHERE id = ?').run(txId);
	return true;
}
