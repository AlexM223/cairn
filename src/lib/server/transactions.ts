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
	estimateTxVsize,
	type ConstructedPsbt,
	type SpendableUtxo,
	type UnconfirmedTrust
} from './bitcoin/psbt';
import { annotateCoinbase } from './bitcoin/coinbaseScan';
import { parseXpub, deriveAddress, addressToScripthash } from './bitcoin/xpub';
import { checkSelectedInputsChainDepth, type ChainDepthWarning } from './chainDepth';
import { broadcastPackage } from './packageRelay';
import {
	BumpError,
	CpfpError,
	executeCpfpDraft,
	executeRbfBump
} from './feeBump';
import { childLogger } from './logger';
import type { ScriptType } from '$lib/types';

// The shared fee-bump engine (RBF + CPFP rules, error classes, package fee
// math) lives in feeBump.ts; re-exported so existing importers — the bump/cpfp
// routes and multisigTransactions.ts — keep working unchanged.
export { BumpError, CpfpError, cpfpChildFee } from './feeBump';

const log = childLogger('transactions');

export type TxStatus = 'draft' | 'awaiting_signature' | 'completed' | 'superseded';

export interface SavedTransaction {
	id: number;
	walletId: number;
	status: TxStatus;
	psbt: string;
	txid: string | null;
	/** First recipient's address (the only one for single-recipient sends). */
	recipient: string;
	/** Total sats across all recipients. */
	amount: number;
	/**
	 * Every recipient with its amount. Always populated: batch rows store this
	 * as JSON in the `recipients` column; single-recipient rows (including all
	 * pre-batch rows) derive it from `recipient`/`amount`.
	 */
	recipients: { address: string; amount: number }[];
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
	// Tag mining-reward (coinbase) outputs so the send flow can enforce maturity
	// and the UI can badge them. Cached, so this is near-free on repeat scans.
	return annotateCoinbase(results.flat());
}

/**
 * Txids this wallet has itself broadcast — the signal that distinguishes an
 * unconfirmed coin that is our OWN change (safe to spend) from one received from
 * a stranger's still-unconfirmed tx (risky). See docs/CPFP-UNCONFIRMED-PLAN.md §6.
 */
export function ownBroadcastTxids(walletId: number): Set<string> {
	const rows = db
		.prepare("SELECT txid FROM transactions WHERE wallet_id = ? AND txid IS NOT NULL")
		.all(walletId) as { txid: string }[];
	return new Set(rows.map((r) => r.txid.toLowerCase()));
}

/** Tag each UNCONFIRMED coin as own-change vs received; confirmed coins pass
 *  through untouched (their trust is irrelevant to selection). Exported so the
 *  multisig builder can reuse the identical policy. */
export function classifyUnconfirmedTrust(
	utxos: SpendableUtxo[],
	ownTxids: Set<string>
): SpendableUtxo[] {
	return utxos.map((u) => {
		if (u.height > 0) return u;
		const trust: UnconfirmedTrust = ownTxids.has(u.txid.toLowerCase())
			? 'own-change'
			: 'received';
		return { ...u, unconfirmedTrust: trust };
	});
}

/**
 * One unconfirmed transaction the wallet has spendable coins on, classified for
 * the "Speed up" decision (docs/CPFP-UNCONFIRMED-PLAN.md §4). This is the
 * backend half of stuck/incoming-tx detection (cairn-u9ob.2) — it builds no UI,
 * it just answers "which of my unconfirmed transactions can be sped up, and how."
 */
export interface UnconfirmedInflow {
	txid: string;
	/** We broadcast this transaction ourselves (it's in our own tx table). */
	ours: boolean;
	/** Own-change (safe) vs received-from-elsewhere (risky) — mirrors coin trust. */
	trust: UnconfirmedTrust;
	/** The tx still signals BIP-125 replaceability (needed for the RBF path). */
	signalsRbf: boolean;
	/** Total sats of OUR spendable unconfirmed outputs on this tx. */
	ourValueSats: number;
	/** Which of our outputs (vout indices) are unconfirmed and spendable. */
	vouts: number[];
	/**
	 * Recommended acceleration per §4's decision table: RBF when we originated
	 * the tx AND it still signals replaceability (we hold every input and can
	 * replace it more cheaply); CPFP otherwise (received funds, or our own tx
	 * that no longer signals RBF — e.g. externally-built change).
	 */
	action: 'rbf' | 'cpfp';
}

/**
 * Given a wallet's live coins and the set of txids it broadcast itself, return
 * one entry per unconfirmed transaction the wallet can accelerate. Confirmed
 * coins are ignored; a tx that has since confirmed (or can't be looked up) is
 * dropped rather than offered. Chain lookups are deduplicated per txid.
 *
 * Shared by single-sig and multisig callers — the only per-wallet-type inputs
 * are the coin set and the "our own txids" set, both supplied by the caller.
 */
export async function detectUnconfirmedInflows(
	utxos: SpendableUtxo[],
	ownTxids: Set<string>
): Promise<UnconfirmedInflow[]> {
	// Group this wallet's UNCONFIRMED coins by the tx that created them.
	const byTxid = new Map<string, { value: number; vouts: number[] }>();
	for (const u of utxos) {
		if (u.height > 0) continue; // confirmed — nothing to speed up
		const key = u.txid.toLowerCase();
		const agg = byTxid.get(key) ?? { value: 0, vouts: [] };
		agg.value += u.value;
		agg.vouts.push(u.vout);
		byTxid.set(key, agg);
	}
	if (byTxid.size === 0) return [];

	const chain = getChain();
	const out: UnconfirmedInflow[] = [];
	for (const [txid, agg] of byTxid) {
		const ours = ownTxids.has(txid);
		// The tx's live replaceability + confirmation state. On a lookup failure we
		// keep the row (the coin is real and spendable) but fall back to CPFP, which
		// works regardless of RBF signaling — except for our own constructions,
		// which Cairn always builds with RBF_SEQUENCE set (§0), so default those to
		// RBF-capable rather than needlessly steering them to the costlier CPFP.
		let signalsRbf = ours;
		try {
			const detail = await chain.getTx(txid);
			if (detail.confirmed) continue; // raced a confirmation — no longer stuck
			signalsRbf = detail.rbf;
		} catch {
			/* keep the fallback above */
		}
		out.push({
			txid,
			ours,
			trust: ours ? 'own-change' : 'received',
			signalsRbf,
			ourValueSats: agg.value,
			vouts: agg.vouts.sort((a, b) => a - b),
			action: ours && signalsRbf ? 'rbf' : 'cpfp'
		});
	}
	return out;
}

/** Wallet-scoped stuck/incoming-tx detection (cairn-u9ob.2), single-sig. */
export async function detectWalletUnconfirmedInflows(
	userId: number,
	walletId: number
): Promise<UnconfirmedInflow[] | null> {
	const wallet = ownedWallet(userId, walletId);
	if (!wallet) return null;
	const utxos = await getWalletUtxos(wallet.xpub);
	return detectUnconfirmedInflows(utxos, ownBroadcastTxids(walletId));
}

export interface BuildDraftInput {
	/** One or more outputs; 'max' only as the sole recipient's amount. */
	recipients: { address: string; amount: number | 'max' }[];
	feeRate: number;
	/** Manual coin control: restrict selection to these coins (see ConstructParams.onlyUtxos). */
	onlyUtxos?: { txid: string; vout: number }[];
}

/**
 * How batch rows persist: `recipient` holds the FIRST address and `amount` the
 * TOTAL sats (so every existing single-recipient consumer — wallet-page rows,
 * explorer links, RBF checks — keeps reading something sensible), while the
 * full per-recipient breakdown goes to the `recipients` JSON column, NULL for
 * single sends. Reads always materialize `recipients` (deriving a length-1
 * array from recipient/amount when the column is NULL), so the send flow's
 * resume path renders every output either way.
 */
function recipientsJson(recipients: { address: string; amount: number }[]): string | null {
	return recipients.length > 1 ? JSON.stringify(recipients) : null;
}

/**
 * Build an unsigned PSBT for a wallet and persist it as a draft.
 * Throws PsbtError with a user-presentable message on any construction issue.
 */
export async function buildDraft(
	userId: number,
	walletId: number,
	input: BuildDraftInput
): Promise<{
	draft: SavedTransaction;
	details: ConstructedPsbt;
	chainDepthWarning: ChainDepthWarning | null;
}> {
	const wallet = ownedWallet(userId, walletId);
	if (!wallet) throw new PsbtError('Wallet not found.', 'construction_failed');

	const scriptType = wallet.script_type as ScriptType;
	// Classify unconfirmed coins so selection can spend our own change but never
	// auto-select a stranger's unconfirmed coin (cairn-u9ob.1).
	const utxos = classifyUnconfirmedTrust(
		await getWalletUtxos(wallet.xpub),
		ownBroadcastTxids(walletId)
	);
	// Tip height enables the coinbase-maturity guard — but only fetch it when a
	// coinbase coin is actually present (the vast majority of wallets have none),
	// and never let a transient tip failure block an ordinary send.
	let tipHeight: number | undefined;
	if (utxos.some((u) => u.coinbase)) {
		try {
			tipHeight = (await getChain().getTip()).height;
		} catch {
			tipHeight = undefined; // tip unavailable — skip the guard, don't block
		}
	}

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
		recipients: input.recipients,
		feeRate: input.feeRate,
		changeAddress,
		changeIndex,
		origin,
		fetchRawTx: (txid) => getChain().getTxHex(txid),
		onlyUtxos: input.onlyUtxos,
		tipHeight
	});

	const res = db
		.prepare(
			`INSERT INTO transactions (wallet_id, status, psbt, recipient, amount, fee, fee_rate, change_index, recipients)
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
			recipientsJson(details.recipients)
		);

	const draft = getTransaction(userId, walletId, Number(res.lastInsertRowid));
	if (!draft) throw new PsbtError('Draft could not be saved.', 'construction_failed');

	// If this draft actually spends an unconfirmed coin, warn (never block) when
	// its mempool chain is near the ancestor/descendant limit (cairn-u9ob.5).
	// Only touches the network when an unconfirmed coin was selected; degrades
	// silently on backends without the v1 CPFP endpoint.
	const chainDepthWarning = await checkSelectedInputsChainDepth(details.inputs, utxos);
	return { draft, details, chainDepthWarning };
}

/** Parse the batch `recipients` JSON column; null/garbage falls back to single-recipient. */
function parseRecipients(
	raw: unknown,
	recipient: string,
	amount: number
): { address: string; amount: number }[] {
	if (typeof raw === 'string' && raw.length > 0) {
		try {
			const parsed = JSON.parse(raw);
			if (Array.isArray(parsed) && parsed.length > 0) {
				return parsed.map((p) => ({ address: String(p.address), amount: Number(p.amount) }));
			}
		} catch {
			/* fall through to the single-recipient shape */
		}
	}
	return [{ address: recipient, amount }];
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
		recipients: parseRecipients(r.recipients, r.recipient as string, r.amount as number),
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

/** Node rejections that a parent+child package can fix: a below-relay-floor
 *  parent, or a child whose parent isn't in this node's mempool. */
const PACKAGE_RESCUABLE_REJECTION =
	/min relay fee|mempool min fee|min fee not met|missingorspent|missing inputs|bad-txns-inputs|too-long-mempool-chain|package/i;

/**
 * Opportunistic package-relay rescue (cairn-u9ob.8): when a single broadcast is
 * rejected for a reason a fee-paying parent+child package could fix, try to
 * resubmit the just-rejected transaction together with its unconfirmed parent(s)
 * as a package. The parents' raw hex is fetched from the chain (only reachable
 * when they've propagated at all); confirmed parents are excluded. Returns the
 * broadcast txid on success, or null to fall back to surfacing the original
 * rejection. Never throws — pure enhancement, must never make a failure worse.
 */
export async function tryPackageRescue(
	signedPsbtBase64: string,
	childRawHex: string,
	childTxid: string,
	rejectionMsg: string
): Promise<string | null> {
	if (!PACKAGE_RESCUABLE_REJECTION.test(rejectionMsg)) return null;
	try {
		const tx = Transaction.fromPSBT(base64.decode(signedPsbtBase64), {
			allowUnknownInputs: true
		});
		const parentTxids = new Set<string>();
		for (let i = 0; i < tx.inputsLength; i++) {
			const inp = tx.getInput(i);
			if (inp.txid) parentTxids.add(bytesToHex(inp.txid));
		}
		if (parentTxids.size === 0) return null;

		const chain = getChain();
		const parentHexes: string[] = [];
		for (const parentTxid of parentTxids) {
			// A confirmed parent doesn't belong in the package; an unreachable one
			// (never propagated) means we can't build a valid package — bail either way.
			let detail;
			try {
				detail = await chain.getTx(parentTxid);
			} catch {
				return null;
			}
			if (detail.confirmed) continue;
			try {
				parentHexes.push(await chain.getTxHex(parentTxid));
			} catch {
				return null; // parent hex unavailable — can't assemble the package
			}
		}
		if (parentHexes.length === 0) return null; // nothing unconfirmed to rescue

		// Parents first (dependency order), then the child.
		const result = await broadcastPackage([...parentHexes, childRawHex]);
		if (result.status !== 'sent') return null;
		log.info({ childTxid, parents: parentHexes.length }, 'broadcast rescued via package relay');
		return childTxid;
	} catch {
		return null; // any failure → fall back to the original rejection
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

	let reportedTxid: string;
	try {
		reportedTxid = await getChain().electrum.broadcast(finalized.rawHex);
	} catch (e) {
		const raw = e instanceof Error ? e.message : String(e);
		// Opportunistic package-relay rescue: if the rejection is one a parent+child
		// package could fix and package relay is available, resubmit with the
		// unconfirmed parent(s). Degrades silently to the original error (cairn-u9ob.8).
		const rescued = await tryPackageRescue(psbt, finalized.rawHex, finalized.txid, raw);
		if (rescued) {
			reportedTxid = rescued;
		} else {
			// Release the claim: a failed broadcast must stay retryable.
			db.prepare('UPDATE transactions SET broadcast_started_at = NULL WHERE id = ?').run(txId);
			// Surface the node's rejection reason in as-plain-as-possible language.
			throw new BroadcastError(`The network rejected this transaction: ${raw}`, 'rejected');
		}
	}

	// A malicious or misbehaving Electrum server can return an arbitrary txid for
	// a broadcast it silently never performed. The real txid is a deterministic
	// double-SHA256 of the exact bytes we just sent (finalized.txid) — recomputed
	// locally, it cannot be forged. If the server's reported txid disagrees, we do
	// NOT trust that the broadcast happened: release the claim so it stays
	// retryable and refuse to record a bogus "sent" txid (cairn-ziwm).
	if (reportedTxid.trim().toLowerCase() !== finalized.txid.toLowerCase()) {
		db.prepare('UPDATE transactions SET broadcast_started_at = NULL WHERE id = ?').run(txId);
		throw new BroadcastError(
			'The server acknowledged the broadcast with a different transaction id than the one we signed — refusing to record it. Check your Electrum server and try again.',
			'rejected'
		);
	}
	const broadcastTxid = finalized.txid;

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
//
// The rules, fee math, and persistence shape for RBF and CPFP live in the
// shared feeBump.ts engine (they are identical for single-sig and multisig);
// these two functions supply only what is wallet-specific — access, input
// recovery, change derivation, and constructPsbt.

/**
 * Build a child-pays-for-parent (CPFP) transaction that accelerates a stuck,
 * still-unconfirmed parent by spending the wallet's own unconfirmed output on it
 * and attaching a high fee, so the parent+child package averages `targetRate`.
 *
 * Unlike RBF this creates a genuinely NEW transaction (no replaces_txid) — the
 * parent stays exactly as broadcast. The qualifying unconfirmed output(s) are
 * forced as inputs via coin control and swept back to the wallet's own change
 * address; the whole thing routes through constructPsbt, not a second builder.
 * See docs/CPFP-UNCONFIRMED-PLAN.md §3.
 */
export async function buildCpfpDraft(
	userId: number,
	walletId: number,
	parentTxid: string,
	targetFeeRate: number
): Promise<{
	draft: SavedTransaction;
	details: ConstructedPsbt;
	cpfp: { parentVsize: number; parentFee: number; childFee: number; targetRate: number };
	chainDepthWarning: ChainDepthWarning | null;
}> {
	const wallet = ownedWallet(userId, walletId);
	if (!wallet) throw new CpfpError('Wallet not found.', 'not_found');
	const scriptType = wallet.script_type as ScriptType;

	return executeCpfpDraft<SavedTransaction, ConstructedPsbt>({
		spec: { table: 'transactions', ownerColumn: 'wallet_id' },
		ownerId: walletId,
		parentTxid,
		targetFeeRate,
		walletNoun: 'wallet',
		getUtxos: () => getWalletUtxos(wallet.xpub),
		prepareChild: async (qualifying) => {
			const parsed = parseXpub(wallet.xpub);
			const changeIndex = await findNextUnusedIndex(wallet.xpub, 1);
			const changeAddress = deriveAddress(parsed, 1, changeIndex).address;
			return {
				changeAddress,
				changeIndex,
				childVsize: estimateTxVsize(scriptType, qualifying.length, [changeAddress])
			};
		},
		buildChild: ({ qualifying, changeAddress, changeIndex, childRate }) => {
			const origin = wallet.master_fingerprint
				? {
						fingerprint: wallet.master_fingerprint,
						path: wallet.derivation_path ?? DEFAULT_ORIGIN_PATH[scriptType]
					}
				: null;
			return constructPsbt({
				xpub: wallet.xpub,
				utxos: qualifying,
				// Send-max sweeps exactly the coin-controlled set (the qualifying coins)
				// back to our own address, minus the CPFP fee.
				recipients: [{ address: changeAddress, amount: 'max' }],
				feeRate: childRate,
				changeAddress,
				changeIndex,
				origin,
				fetchRawTx: (txid) => getChain().getTxHex(txid),
				onlyUtxos: qualifying.map((u) => ({ txid: u.txid, vout: u.vout }))
			});
		},
		isCoinTooSmall: (e) =>
			e instanceof PsbtError && (e.code === 'insufficient_funds' || e.code === 'no_utxos'),
		reloadDraft: (rowId) => getTransaction(userId, walletId, rowId),
		draftSaveError: () => new PsbtError('CPFP draft could not be saved.', 'construction_failed')
	});
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

	return executeRbfBump<SavedTransaction, ConstructedPsbt>({
		spec: { table: 'transactions', ownerColumn: 'wallet_id' },
		ownerId: walletId,
		tx,
		newFeeRate,
		buildReplacement: (stored, changeIndex) => {
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
			const changeAddress = deriveAddress(parsed, 1, changeIndex).address;

			// Embed derivation metadata only when it is both known for the wallet AND
			// was recoverable from the original's inputs (see recoverPsbtInputs).
			const origin =
				derivationKnown && wallet.master_fingerprint
					? {
							fingerprint: wallet.master_fingerprint,
							path: wallet.derivation_path ?? DEFAULT_ORIGIN_PATH[scriptType]
						}
					: null;

			// Every recipient output is reproduced exactly — for batch rows the stored
			// per-recipient breakdown drives this, so a bumped batch keeps paying all N
			// destinations; the fee increase still comes solely out of change.
			return constructPsbt({
				xpub: wallet.xpub,
				utxos,
				recipients: tx.recipients,
				feeRate: newFeeRate,
				changeAddress,
				changeIndex,
				origin,
				fetchRawTx: (txid) => getChain().getTxHex(txid),
				exactInputs: true
			});
		},
		reloadDraft: (rowId) => getTransaction(userId, walletId, rowId),
		draftSaveError: () => new PsbtError('Draft could not be saved.', 'construction_failed')
	});
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
