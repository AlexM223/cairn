// Transaction lifecycle service: builds unsigned PSBTs from a wallet's live
// UTXO set and persists them through draft → awaiting-signature → completed.

import { base64 } from '@scure/base';
import { Transaction } from '@scure/btc-signer';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { db } from './db';
import { getChain } from './chain';
import { scanWallet, findNextUnusedIndex } from './bitcoin/walletScan';
import {
	constructPsbt,
	finalizePsbt,
	assertSameTransaction,
	addressFromScript,
	PsbtMismatchError,
	DEFAULT_ORIGIN_PATH,
	PsbtError,
	type ConstructedPsbt,
	type SpendableUtxo
} from './bitcoin/psbt';
import { parseXpub, deriveAddress, addressToScripthash } from './bitcoin/xpub';
import type { ScriptType } from '$lib/types';

export type TxStatus = 'draft' | 'awaiting_signature' | 'completed' | 'superseded';

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
	/** txid of the broadcast transaction this row was built to replace (RBF). */
	replacesTxid: string | null;
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
		replacesTxid: (r.replaces_txid as string | null) ?? null,
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

/** A file that is recognizably meant to be a PSBT but cannot be parsed. */
export class InvalidPsbtError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'InvalidPsbtError';
	}
}

/**
 * Structural check beyond the magic bytes: a truncated or bit-rotted file
 * that still starts with "psbt\xff" must fail HERE with a plain "corrupted"
 * message, not later in the substitution guard with an alarming mismatch one.
 */
function assertParseablePsbt(bytes: Uint8Array): Uint8Array {
	try {
		Transaction.fromPSBT(bytes);
	} catch {
		throw new InvalidPsbtError(
			'This PSBT could not be read — it may be truncated or corrupted. Try exporting it from your signer again.'
		);
	}
	return bytes;
}

/**
 * Accept a PSBT in any of the shapes signers hand back — base64 text, hex
 * text, or base64-of-a-text-file that itself contains base64/hex — and return
 * canonical base64 of the raw binary. Throws on anything that isn't a PSBT
 * (InvalidPsbtError when it looks like one but doesn't parse).
 */
export function normalizePsbt(input: string, depth = 0): string {
	const trimmed = input.trim();
	if (!trimmed) throw new Error('Empty PSBT');

	if (new RegExp(`^${PSBT_MAGIC_HEX}[0-9a-fA-F]*$`, 'i').test(trimmed)) {
		return base64.encode(assertParseablePsbt(hexToBytes(trimmed.toLowerCase())));
	}

	const bytes = base64.decode(trimmed); // throws on non-base64
	if (hasPsbtMagic(bytes)) return base64.encode(assertParseablePsbt(bytes));

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
		} catch (e) {
			// A recognizably-PSBT-but-corrupt file gets its specific message;
			// everything else (not base64, wrong magic, …) the generic one.
			throw new BroadcastError(
				e instanceof InvalidPsbtError ? e.message : "That doesn't look like a valid PSBT.",
				'incomplete'
			);
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

	// Atomically claim the broadcast before touching the network. The opening
	// read-check above gives friendly errors but is racy on its own: two
	// concurrent calls can both see txid IS NULL while the first is awaiting
	// Electrum. This single guarded UPDATE lets exactly one caller through;
	// the loser sees zero affected rows and gets the same already-sent error.
	// A stale claim (crash mid-broadcast) expires after 60s so the user can
	// retry rather than being wedged forever.
	const claimed = db
		.prepare(
			`UPDATE transactions
			 SET broadcast_started_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
			     updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
			 WHERE id = ? AND wallet_id = ? AND txid IS NULL AND status != 'completed'
			   AND (broadcast_started_at IS NULL
			        OR broadcast_started_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-60 seconds'))`
		)
		.run(txId, walletId);
	if (Number(claimed.changes) === 0) {
		throw new BroadcastError('This transaction has already been broadcast.', 'already_sent');
	}

	let broadcastTxid: string;
	try {
		broadcastTxid = await getChain().electrum.broadcast(finalized.rawHex);
	} catch (e) {
		// Release the claim: a failed broadcast must stay retryable.
		db.prepare('UPDATE transactions SET broadcast_started_at = NULL WHERE id = ?').run(txId);
		// Surface the node's rejection reason in as-plain-as-possible language.
		const raw = e instanceof Error ? e.message : String(e);
		throw new BroadcastError(`The network rejected this transaction: ${raw}`, 'rejected');
	}

	const updated = updateTransaction(userId, walletId, txId, {
		status: 'completed',
		psbt,
		txid: broadcastTxid
	});

	// A successfully broadcast RBF replacement supersedes the transaction it was
	// built to displace: both spend the same inputs, so only one can ever
	// confirm, and the network has now been told to prefer this one. The
	// original stays on record (it WAS broadcast) but leaves the 'completed'
	// pool so nothing treats it as the live payment anymore.
	if (updated?.replacesTxid) {
		db.prepare(
			`UPDATE transactions
			 SET status = 'superseded',
			     updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
			 WHERE wallet_id = ? AND txid = ? AND status = 'completed'`
		).run(walletId, updated.replacesTxid);
	}

	return { txid: broadcastTxid, transaction: updated! };
}

// ------------------------------------------------------------ RBF fee bumping

/** BIP-125 signaling threshold: any input sequence below this opts in to RBF. */
const RBF_SIGNAL_MAX_SEQUENCE = 0xfffffffe;

export class BumpError extends Error {
	constructor(
		message: string,
		public readonly code:
			| 'not_found'
			| 'not_bumpable'
			| 'confirmed'
			| 'superseded'
			| 'already_replaced'
			| 'not_rbf'
			| 'no_change'
			| 'fee_too_low'
	) {
		super(message);
		this.name = 'BumpError';
	}
}

/**
 * Recover the exact coins a stored PSBT spends, from the PSBT itself: txid and
 * vout from the input, value/scriptPubKey from witnessUtxo (segwit) or the
 * referenced output of the embedded nonWitnessUtxo (legacy), and the wallet
 * derivation (chain/index) from the bip32Derivation Cairn embeds when the
 * key's origin is known. `derivationKnown` is false when ANY input lacks a
 * usable path — the replacement then omits derivation metadata rather than
 * fabricating wrong paths a signer would trip over.
 */
function recoverPsbtInputs(tx: Transaction): {
	utxos: SpendableUtxo[];
	derivationKnown: boolean;
} {
	const utxos: SpendableUtxo[] = [];
	let derivationKnown = true;

	for (let i = 0; i < tx.inputsLength; i++) {
		const inp = tx.getInput(i);
		if (!inp.txid || inp.index === undefined) {
			throw new BumpError(
				'The stored transaction is missing input data and cannot be reconstructed.',
				'not_bumpable'
			);
		}

		let value: number | null = null;
		let script: Uint8Array | null = null;
		if (inp.witnessUtxo) {
			value = Number(inp.witnessUtxo.amount);
			script = inp.witnessUtxo.script ?? null;
		} else if (inp.nonWitnessUtxo) {
			const prevOut = inp.nonWitnessUtxo.outputs[inp.index];
			if (prevOut) {
				value = Number(prevOut.amount);
				script = prevOut.script ?? null;
			}
		}
		const address = script ? addressFromScript(script) : null;
		if (value === null || !address) {
			throw new BumpError(
				'The stored transaction does not carry enough coin data to rebuild it.',
				'not_bumpable'
			);
		}

		// Cairn's own PSBTs carry path [...account, chain, index] on each input.
		let chain: 0 | 1 = 0;
		let index = 0;
		const path = inp.bip32Derivation?.[0]?.[1]?.path;
		const chainSeg = path?.[path.length - 2];
		const indexSeg = path?.[path.length - 1];
		if ((chainSeg === 0 || chainSeg === 1) && typeof indexSeg === 'number' && indexSeg >= 0) {
			chain = chainSeg;
			index = indexSeg;
		} else {
			derivationKnown = false;
		}

		utxos.push({
			txid: bytesToHex(inp.txid),
			vout: inp.index,
			value,
			// Height is irrelevant here: exact-inputs construction skips the
			// confirmed-only filter (these coins funded an already-broadcast tx).
			height: 1,
			address,
			chain,
			index
		});
	}

	return { utxos, derivationKnown };
}

/**
 * Build a replace-by-fee (BIP-125) replacement for a broadcast-but-unconfirmed
 * transaction: identical inputs, same recipient and amount, higher fee taken
 * entirely out of the change output. The replacement is saved as a fresh draft
 * (replaces_txid → the original's txid) and re-enters the normal
 * sign-and-broadcast flow; the original is marked 'superseded' only once the
 * replacement actually broadcasts.
 */
export async function bumpTransaction(
	userId: number,
	walletId: number,
	txId: number,
	newFeeRate: number
): Promise<{ draft: SavedTransaction; details: ConstructedPsbt }> {
	const wallet = ownedWallet(userId, walletId);
	const tx = wallet ? getTransaction(userId, walletId, txId) : null;
	if (!wallet || !tx) throw new BumpError('Transaction not found.', 'not_found');

	if (tx.status === 'superseded') {
		throw new BumpError(
			'This transaction was already replaced by a fee bump.',
			'superseded'
		);
	}
	if (tx.status !== 'completed' || !tx.txid) {
		throw new BumpError(
			'Only broadcast transactions can be fee-bumped — this one has not been sent yet.',
			'not_bumpable'
		);
	}

	// One live replacement per original: a second concurrent bump would produce
	// two drafts fighting over the same inputs.
	const existing = db
		.prepare('SELECT id, status FROM transactions WHERE wallet_id = ? AND replaces_txid = ?')
		.get(walletId, tx.txid) as { id: number; status: string } | undefined;
	if (existing) {
		throw new BumpError(
			existing.status === 'completed'
				? 'This transaction was already replaced by a fee bump.'
				: 'A replacement for this transaction is already in progress — finish or discard it first.',
			'already_replaced'
		);
	}

	// A confirmed transaction is final; there is no fee left to bump. A failed
	// lookup (mempool eviction, backend outage) does NOT block the bump — a
	// replacement draft is harmless either way, and the network will simply
	// treat it as a fresh transaction if the original is truly gone.
	let confirmed = false;
	try {
		confirmed = (await getChain().getTx(tx.txid)).confirmed;
	} catch {
		confirmed = false;
	}
	if (confirmed) {
		throw new BumpError(
			'This transaction has already confirmed — there is no fee to bump.',
			'confirmed'
		);
	}

	let stored: Transaction;
	try {
		stored = Transaction.fromPSBT(base64.decode(tx.psbt));
	} catch {
		throw new BumpError(
			'The stored transaction could not be read, so it cannot be reconstructed.',
			'not_bumpable'
		);
	}

	// BIP-125 rule 1: every input must signal replaceability. Transactions
	// built before Cairn set RBF_SEQUENCE on all inputs may not — the network
	// would silently ignore a replacement, so refuse up front.
	for (let i = 0; i < stored.inputsLength; i++) {
		if ((stored.getInput(i).sequence ?? 0xffffffff) >= RBF_SIGNAL_MAX_SEQUENCE) {
			throw new BumpError(
				"This transaction doesn't signal RBF (replace-by-fee), so the network won't accept a replacement — it can't be fee-bumped.",
				'not_rbf'
			);
		}
	}

	// The fee increase comes out of change; a changeless original has nowhere
	// to take it from without shortchanging the recipient.
	if (tx.changeIndex === null) {
		throw new BumpError(
			'This transaction has no change output to absorb a higher fee, so it cannot be bumped.',
			'no_change'
		);
	}

	if (!Number.isFinite(newFeeRate) || newFeeRate <= tx.feeRate) {
		throw new BumpError(
			`The new fee rate must be higher than the original's effective ${tx.feeRate} sat/vB.`,
			'fee_too_low'
		);
	}

	const { utxos, derivationKnown } = recoverPsbtInputs(stored);

	const scriptType = wallet.script_type as ScriptType;
	// Rebuilding a wrapped-segwit spend needs each input's redeem script, which
	// is derived from the exact child key — unrecoverable without paths.
	if (!derivationKnown && scriptType === 'p2sh-p2wpkh') {
		throw new BumpError(
			'The stored transaction is missing the derivation data needed to rebuild it.',
			'not_bumpable'
		);
	}

	// Same change destination as the original: the row stores the change-chain
	// index, and the address re-derives deterministically from the xpub.
	const parsed = parseXpub(wallet.xpub);
	const changeAddress = deriveAddress(parsed, 1, tx.changeIndex).address;

	// Embed derivation metadata only when it is both known for the wallet AND
	// was recoverable from the original's inputs (see recoverPsbtInputs).
	const origin =
		derivationKnown && wallet.master_fingerprint
			? {
					fingerprint: wallet.master_fingerprint,
					path: wallet.derivation_path ?? DEFAULT_ORIGIN_PATH[scriptType]
				}
			: null;

	const details = await constructPsbt({
		xpub: wallet.xpub,
		utxos,
		recipient: tx.recipient,
		amount: tx.amount,
		feeRate: newFeeRate,
		changeAddress,
		changeIndex: tx.changeIndex,
		origin,
		fetchRawTx: (txid) => getChain().getTxHex(txid),
		exactInputs: true
	});

	// BIP-125 rule 4: the replacement must pay for its own relay — at least the
	// original's fee plus (replacement vsize × 1 sat/vB), 1 sat/vB being the
	// default incremental relay fee. Our vsize is the same estimator used for
	// fee pricing, which slightly over-approximates real size — erring toward a
	// marginally higher minimum, never an under-paying replacement.
	const minFee = tx.fee + details.vsize;
	if (details.fee < minFee) {
		const minRate = Math.ceil(minFee / details.vsize);
		throw new BumpError(
			`The replacement must pay at least ${minFee} sats (the original fee plus 1 sat/vB for its own size) — try ${minRate} sat/vB or more.`,
			'fee_too_low'
		);
	}

	const res = db
		.prepare(
			`INSERT INTO transactions (wallet_id, status, psbt, recipient, amount, fee, fee_rate, change_index, replaces_txid)
			 VALUES (?, 'draft', ?, ?, ?, ?, ?, ?, ?)`
		)
		.run(
			walletId,
			details.psbtBase64,
			details.recipient,
			details.amount,
			details.fee,
			details.feeRate,
			details.change?.index ?? null,
			tx.txid
		);

	const draft = getTransaction(userId, walletId, Number(res.lastInsertRowid));
	if (!draft) throw new PsbtError('Draft could not be saved.', 'construction_failed');
	return { draft, details };
}

export function deleteTransaction(userId: number, walletId: number, txId: number): boolean {
	if (!getTransaction(userId, walletId, txId)) return false;
	// Completed (and superseded — they were broadcast too) transactions are
	// history — deleting them would erase the record that a broadcast happened.
	const status = getTransaction(userId, walletId, txId)?.status;
	if (status === 'completed' || status === 'superseded') return false;
	db.prepare('DELETE FROM transactions WHERE id = ?').run(txId);
	return true;
}
