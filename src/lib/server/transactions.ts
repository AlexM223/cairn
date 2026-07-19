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
	PsbtNotFullySignedError,
	PsbtSighashError,
	DEFAULT_ORIGIN_PATH,
	PsbtError,
	estimateTxVsize,
	type ConstructedPsbt,
	type SpendableUtxo,
	type UnconfirmedTrust
} from './bitcoin/psbt';
import { annotateCoinbase } from './bitcoin/coinbaseScan';
import type { ElectrumUnspent } from './electrum/client';
import type { ElectrumLane } from './electrum/pool';
import { parseXpub, deriveAddress, addressToScripthash } from './bitcoin/xpub';
import type { ChainDepthWarning } from './chainDepth';
import {
	BumpError,
	CpfpError,
	executeCpfpDraft,
	executeRbfBump,
	type TxTableSpec
} from './feeBump';
import {
	BroadcastError,
	executeBroadcast,
	executeBuildDraft,
	updateSpendRow,
	deleteSpendDraft,
	ownBroadcastedTxids,
	reservedSpendCoins,
	parseRecipients,
	type ReservationWarning
} from './spendLifecycle';
import type { ScriptType } from '$lib/types';

// The shared fee-bump engine (RBF + CPFP rules, error classes, package fee
// math) lives in feeBump.ts; the shared spend-record lifecycle engine
// (broadcast claim/dedup, draft-build skeleton, coin reservation, unconfirmed-
// coin trust classification) lives in spendLifecycle.ts (cairn-rg99). Both are
// re-exported so existing importers — the bump/cpfp/broadcast routes,
// multisigTransactions.ts, and the QA suites — keep working unchanged.
// BroadcastError is re-exported by CLASS IDENTITY (tests assert instanceof).
export { BumpError, CpfpError, cpfpChildFee } from './feeBump';
export {
	BroadcastError,
	tryPackageRescue,
	classifyUnconfirmedTrust,
	coinsReservedByDrafts,
	reservationErrorMessage,
	reservationWarningFor
} from './spendLifecycle';
export type { ReservationWarning } from './spendLifecycle';

/** This service's storage location in the shared lifecycle engine (cairn-rg99). */
const SPEC: TxTableSpec = { table: 'transactions', ownerColumn: 'wallet_id' };

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

/**
 * Live spendable UTXOs for a wallet, attributed to derivation indices. `lane`
 * (default 'interactive') routes the Electrum traffic — the background snapshot
 * refresh passes 'background'; the send flow uses the interactive default.
 */
export async function getWalletUtxos(
	xpub: string,
	lane: ElectrumLane = 'interactive'
): Promise<SpendableUtxo[]> {
	const chain = getChain();
	const scan = await scanWallet(xpub, { lane });
	const candidates = scan.addresses.filter((a) => a.used || a.balance > 0);
	if (candidates.length === 0) return annotateCoinbase([]);

	// One batched listunspent for all candidate addresses (real JSON-RPC batching
	// via the client's batchRequest), NOT N separate .listUnspent() facade calls —
	// each of those would independently pick() a socket, spraying N requests across
	// the whole pool; batching pipelines them onto ONE (lane-appropriate) socket in
	// a single call, so a background scan's UTXO fetch stays inside the background
	// lane instead of leaking onto the reserved interactive socket.
	const unspents = (await chain.electrum.batchRequest(
		candidates.map((addr) => ({
			method: 'blockchain.scripthash.listunspent',
			params: [addressToScripthash(addr.address)]
		})),
		lane
	)) as ElectrumUnspent[][];

	const results = candidates.map((addr, i) =>
		(unspents[i] ?? []).map((u) => ({
			txid: u.tx_hash,
			vout: u.tx_pos,
			value: u.value,
			height: u.height,
			address: addr.address,
			chain: (addr.change ? 1 : 0) as 0 | 1,
			index: addr.index
		}))
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
	return ownBroadcastedTxids(SPEC, walletId);
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
	/**
	 * True when the parent's own network fee could NOT be resolved (Core
	 * returned fee: null — some prevout couldn't be decorated, see
	 * toTxDetailFromCore in chain/index.ts). executeCpfpDraft's CPFP fee math
	 * (feeBump.ts) needs this value and always throws CpfpError
	 * 'parent_fee_unknown' when it's missing — deterministically, not a
	 * transient failure, since the same lookup runs again at submit time and
	 * would return the same null. Only meaningful when `action` is 'cpfp'
	 * (RBF replacement never reads the parent's fee); the caller uses this to
	 * hide the CPFP "Speed up" affordance entirely for this tx rather than
	 * offer a control that's guaranteed to fail with an apology (cairn-iare).
	 * A lookup that fails outright (network/RPC hiccup, caught below) is a
	 * DIFFERENT, transient case — left false here so the control still shows
	 * and a retry at submit time gets a fair shot.
	 */
	parentFeeUnknown: boolean;
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
		// cairn-iare: only a SUCCESSFUL lookup that comes back with fee === null
		// means CPFP is deterministically impossible for this tx (see the field
		// doc above) — a failed lookup is transient and must not set this.
		let parentFeeUnknown = false;
		try {
			const detail = await chain.getTx(txid);
			if (detail.confirmed) continue; // raced a confirmation — no longer stuck
			signalsRbf = detail.rbf;
			parentFeeUnknown = detail.fee == null;
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
			action: ours && signalsRbf ? 'rbf' : 'cpfp',
			parentFeeUnknown
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

// Coin reservation (cairn QA R7 §4.7 B4) lives in spendLifecycle.ts —
// coinsReservedByDrafts / reservationErrorMessage / reservationWarningFor are
// re-exported above for existing importers (multisigTransactions.ts, the
// disruption suites).

/** In-flight (pre-broadcast) draft coin references for one wallet. */
export function reservedWalletCoins(walletId: number): Map<string, number[]> {
	return reservedSpendCoins(SPEC, walletId);
}

/**
 * Build an unsigned PSBT for a wallet and persist it as a draft.
 * Throws PsbtError with a user-presentable message on any construction issue.
 *
 * The lifecycle skeleton — per-wallet lock (cairn QA R7 B4 follow-up),
 * unconfirmed-coin trust classification (cairn-u9ob.1), the coinbase-maturity
 * tip fetch (cairn-oae1.1), reservation exclusion + shortfall reframe (cairn
 * QA R7 B4), draft persistence, and the chain-depth/reservation warnings —
 * runs in spendLifecycle.executeBuildDraft, shared verbatim with the multisig
 * side; this function supplies only what is single-sig-specific: ownership
 * resolution, the wallet's UTXO source, change derivation from the xpub, and
 * constructPsbt.
 */
export async function buildDraft(
	userId: number,
	walletId: number,
	input: BuildDraftInput
): Promise<{
	draft: SavedTransaction;
	details: ConstructedPsbt;
	chainDepthWarning: ChainDepthWarning | null;
	reservationWarning: ReservationWarning | null;
}> {
	return executeBuildDraft<WalletRow, SavedTransaction, ConstructedPsbt>({
		spec: SPEC,
		ownerId: walletId,
		lockKey: `wallet:${walletId}`,
		onlyUtxos: input.onlyUtxos,
		prepare: () => ownedWallet(userId, walletId),
		notFoundError: () => new PsbtError('Wallet not found.', 'construction_failed'),
		getUtxos: (wallet) => getWalletUtxos(wallet.xpub),
		buildPsbt: async (wallet, { utxos, tipHeight }) => {
			const scriptType = wallet.script_type as ScriptType;

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

			return constructPsbt({
				xpub: wallet.xpub,
				utxos,
				recipients: input.recipients,
				feeRate: input.feeRate,
				// The node's own relay floor gates the fee (cairn-eacw.2): a sub-1 fee
				// builds on a node that relays below 1 sat/vB, and the rejection message
				// quotes the real floor. Never throws — falls back to 1 sat/vB.
				minFeeRate: await getChain().getMinFeeRate(),
				changeAddress,
				changeIndex,
				origin,
				fetchRawTx: (txid) => getChain().getTxHex(txid),
				onlyUtxos: input.onlyUtxos,
				tipHeight
			});
		},
		reload: (rowId) => getTransaction(userId, walletId, rowId),
		draftSaveError: () => new PsbtError('Draft could not be saved.', 'construction_failed')
	});
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

/**
 * Distinct addresses this wallet has successfully PAID before — the R2
 * (docs/UX-PSYCHOLOGY-RESEARCH-2026-07-15.md) first-send signal for the send
 * review's stake-triggered recipient-verification micro-step. Only
 * status='completed' (actually broadcast) rows count: a draft or
 * awaiting-signature row never left the wallet, and a superseded row may
 * represent a mistake that was caught before it ever sent — neither
 * establishes "we've paid this address before" confidence. No new table:
 * this reads the existing transactions rows the same way listTransactions
 * does.
 */
export function sentRecipientAddresses(userId: number, walletId: number): string[] {
	const rows = listTransactions(userId, walletId) ?? [];
	const set = new Set<string>();
	for (const r of rows) {
		if (r.status !== 'completed') continue;
		for (const rec of r.recipients) set.add(rec.address);
	}
	return [...set];
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

	updateSpendRow(SPEC, txId, fields);

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

/**
 * Finalize a saved transaction's (fully-signed) PSBT and broadcast it. Guards
 * against double-broadcast: a transaction already carrying a txid is refused.
 * On success the txid is recorded and the row moves to 'completed' — unless
 * another row of this wallet already completed with the identical txid, in
 * which case this row is recorded as a duplicate instead.
 *
 * The whole broadcast pipeline — already-sent guard, early/late duplicate
 * dedup (cairn QA R7 B4 sub-case 1), the atomic broadcast claim, package-relay
 * rescue (cairn-u9ob.8), reported-txid verification (cairn-ziwm), RBF
 * supersede bookkeeping, wallet-dirty marking (cairn-g1u2) — runs in
 * spendLifecycle.executeBroadcast, shared verbatim with the multisig side.
 * This function supplies only what is single-sig-specific: the substitution
 * guard on an optionally-supplied signed PSBT, and single-sig finalization
 * with its friendly missing-signature/sighash messages.
 */
export async function broadcastTransaction(
	userId: number,
	walletId: number,
	txId: number,
	signedPsbt?: string
): Promise<{ txid: string; transaction: SavedTransaction; duplicate?: boolean; message?: string }> {
	const tx = getTransaction(userId, walletId, txId);
	if (!tx) throw new BroadcastError('Transaction not found.', 'not_found');

	return executeBroadcast<SavedTransaction>({
		spec: SPEC,
		ownerId: walletId,
		txId,
		tx,
		preparePsbt: (tx) => {
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
			return { psbt, tx };
		},
		finalize: (psbt) => {
			try {
				return finalizePsbt(psbt);
			} catch (e) {
				// Genuinely-missing signatures get an accurate count; anything else
				// (parse failure, malformed signature data, …) gets a generic message —
				// never btc-signer's raw exception text, which reads as a library-author
				// message, not an end-user one (cairn QA F3). Notably, an input an
				// external signer already finalized (e.g. Bitcoin Core's
				// descriptorprocesspsbt/walletprocesspsbt default finalize=true) is NOT
				// an error case at all — finalizePsbt passes those through.
				if (e instanceof PsbtNotFullySignedError) {
					const plural = e.totalCount === 1 ? '' : 's';
					throw new BroadcastError(
						`This transaction isn't fully signed yet — ${e.unsignedCount} of ${e.totalCount} input${plural} still need${e.unsignedCount === 1 ? 's' : ''} a signature. Sign it with your device or wallet, then try again.`,
						'incomplete'
					);
				}
				// A wrong-sighash signature is user-actionable (re-sign with SIGHASH_ALL) —
				// surface its clear message rather than the generic finalize failure.
				if (e instanceof PsbtSighashError) {
					throw new BroadcastError(e.message, 'incomplete');
				}
				throw new BroadcastError(
					"This transaction couldn't be finalized. Make sure it's fully signed, then try again.",
					'incomplete'
				);
			}
		},
		reload: (rowId) => getTransaction(userId, walletId, rowId)
	});
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
		spec: SPEC,
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
		buildChild: ({ qualifying, changeAddress, changeIndex, childRate, floor }) => {
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
				// childRate is already clamped to this floor; pass it so a sub-1 child
				// isn't re-rejected by the default 1 sat/vB validation (cairn-eacw.2).
				minFeeRate: floor,
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
		spec: SPEC,
		ownerId: walletId,
		tx,
		newFeeRate,
		buildReplacement: (stored, changeIndex, minFeeRate) => {
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
				// Node relay floor (cairn-eacw.2): a replacement bumping a sub-1 original
				// isn't rejected before BIP-125 rule 4 runs. Rule 4 still forces the
				// effective rate up by ~1 sat/vB, so this rarely stays sub-1 in practice.
				minFeeRate,
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
	// The atomic conditional DELETE (cairn-up0q TOCTOU fix + cairn-ytnc stale-
	// claim window) lives in spendLifecycle.deleteSpendDraft, shared with the
	// multisig side.
	return deleteSpendDraft(SPEC, walletId, txId);
}
