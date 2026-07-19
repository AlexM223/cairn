// Multisig-transaction lifecycle service: builds unsigned multisig PSBTs from a
// multisig's live UTXO set and persists them through draft → awaiting-signature
// (one merged signature at a time, until quorum) → completed (broadcast).
//
// The lifecycle itself — draft persistence, coin reservation, the atomic
// broadcast claim, duplicate dedup, RBF supersede bookkeeping — is the SAME
// implementation transactions.ts runs, in spendLifecycle.ts (cairn-rg99),
// parameterized by the parallel multisig_transactions table (see db.ts for why
// the schema stays parallel, not merged). This file supplies only what is
// genuinely multisig: access tiers, roster coordination, and the structural
// difference from wallet sends — a stored PSBT here accumulates signatures
// across SEVERAL attach calls, merged by combineMultisigPsbts, and broadcast
// refuses to proceed below the multisig's M-of-N quorum.

import { Transaction } from '@scure/btc-signer';
import { bytesToHex } from '@noble/hashes/utils.js';
import { db } from './db';
import { getChain } from './chain';
import {
	getMultisig,
	getViewableMultisig,
	getSignableMultisig,
	toMultisigConfig,
	type MultisigRow
} from './wallets/multisig';
import { deriveMultisigAddress } from './bitcoin/multisig';
import { getMultisigUtxos, nextMultisigChangeIndex } from './multisigScan';
import {
	freezeRosterAndNotify,
	notifyRosterProgress,
	notifySignSessionComplete,
	isRosterMember
} from './multisigRoster';
import {
	constructMultisigPsbt,
	combineMultisigPsbts,
	multisigPsbtProgress,
	finalizeMultisigPsbt,
	estimateMultisigTxVsize,
	MultisigPsbtError,
	type ConstructedMultisigPsbt,
	type MultisigSigningProgress
} from './bitcoin/multisigPsbt';
import { PsbtError, type SpendableUtxo } from './bitcoin/psbt';
import { normalizePsbt, InvalidPsbtError, detectUnconfirmedInflows, type UnconfirmedInflow } from './transactions';
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
	parseRecipients,
	type ReservationWarning
} from './spendLifecycle';
import type { ChainDepthWarning } from './chainDepth';

/** This service's storage location in the shared lifecycle engine (cairn-rg99). */
const SPEC: TxTableSpec = { table: 'multisig_transactions', ownerColumn: 'multisig_id' };

export type MultisigTxStatus = 'draft' | 'awaiting_signature' | 'completed' | 'superseded';

export interface SavedMultisigTransaction {
	id: number;
	multisigId: number;
	status: MultisigTxStatus;
	/** The CURRENT combined PSBT — replaced every time a signature merges in. */
	psbt: string;
	txid: string | null;
	/** First recipient's address (the only one for single-recipient sends). */
	recipient: string;
	/** Total sats across all recipients. */
	amount: number;
	/** Every recipient with its amount (length-1 for single sends). */
	recipients: { address: string; amount: number }[];
	fee: number;
	feeRate: number;
	changeIndex: number | null;
	/** txid of the broadcast transaction this row was built to replace (RBF), or
	 *  null for an ordinary draft. See bumpMultisigTransaction. */
	replacesTxid: string | null;
	createdAt: string;
	updatedAt: string;
}

// Access tiers (see docs/COLLABORATIVE-CUSTODY-PLAN.md §3): a saved
// transaction's FULL shape (raw PSBT — recipients, amounts, BIP32 derivation)
// is cosigner-reachable (owner or role='cosigner'), consistent with the
// key-path redaction viewers already get elsewhere (cairn-o1dp.1); viewers get
// only the projected summary via listMultisigTransactionSummaries.
// Building/signing is cosigner-reachable; broadcast stays owner-only (gated at
// its call site with getMultisig directly). Every gate returns null for a
// non-participant exactly like a missing wallet, so callers surface a uniform
// 404 and never leak a wallet's existence.
function viewableMultisig(userId: number, multisigId: number): MultisigRow | null {
	return getViewableMultisig(userId, multisigId);
}

function signableMultisig(userId: number, multisigId: number): MultisigRow | null {
	return getSignableMultisig(userId, multisigId);
}

function mapRow(r: Record<string, unknown>): SavedMultisigTransaction {
	return {
		id: r.id as number,
		multisigId: r.multisig_id as number,
		status: r.status as MultisigTxStatus,
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

export function getMultisigTransaction(
	userId: number,
	multisigId: number,
	txId: number
): SavedMultisigTransaction | null {
	if (!signableMultisig(userId, multisigId)) return null;
	const row = db
		.prepare('SELECT * FROM multisig_transactions WHERE id = ? AND multisig_id = ?')
		.get(txId, multisigId) as Record<string, unknown> | undefined;
	return row ? mapRow(row) : null;
}

export function listMultisigTransactions(
	userId: number,
	multisigId: number
): SavedMultisigTransaction[] | null {
	if (!signableMultisig(userId, multisigId)) return null;
	const rows = db
		.prepare('SELECT * FROM multisig_transactions WHERE multisig_id = ? ORDER BY created_at DESC, id DESC')
		.all(multisigId) as Record<string, unknown>[];
	return rows.map(mapRow);
}

/**
 * Distinct addresses this multisig has successfully PAID before — the
 * multisig mirror of transactions.ts's sentRecipientAddresses, feeding the
 * same R2 first-send signal (docs/UX-PSYCHOLOGY-RESEARCH-2026-07-15.md) for
 * the shared SendReviewCard. Only status='completed' rows count (see the
 * single-sig version's doc comment for why). Multisig has no address book,
 * so this is the WHOLE "known addresses" signal here, not just part of it.
 */
export function sentMultisigRecipientAddresses(userId: number, multisigId: number): string[] {
	const rows = listMultisigTransactions(userId, multisigId) ?? [];
	const set = new Set<string>();
	for (const r of rows) {
		if (r.status !== 'completed') continue;
		for (const rec of r.recipients) set.add(rec.address);
	}
	return [...set];
}

/** The PSBT-free projection of a saved transaction a pure viewer may see. */
export interface MultisigTransactionSummary {
	id: number;
	txid: string | null;
	status: MultisigTxStatus;
	feeRate: number;
}

/**
 * Viewer-reachable list of saved transactions, projected down to the summary
 * the wallet-overview page shows. Deliberately never selects the psbt (or
 * recipient/amount) columns — a read-only viewer share must not be able to
 * reconstruct an in-flight draft (cairn-o1dp.1).
 */
export function listMultisigTransactionSummaries(
	userId: number,
	multisigId: number
): MultisigTransactionSummary[] | null {
	if (!viewableMultisig(userId, multisigId)) return null;
	const rows = db
		.prepare(
			'SELECT id, txid, status, fee_rate FROM multisig_transactions WHERE multisig_id = ? ORDER BY created_at DESC, id DESC'
		)
		.all(multisigId) as Record<string, unknown>[];
	return rows.map((r) => ({
		id: r.id as number,
		txid: (r.txid as string | null) ?? null,
		status: r.status as MultisigTxStatus,
		feeRate: r.fee_rate as number
	}));
}

/**
 * Quorum progress for a saved multisig transaction — a thin ownership-scoped
 * wrapper over multisigPsbtProgress, the single progress authority. Null when
 * the stored PSBT cannot be parsed (callers own the "corrupt" presentation).
 */
export function multisigTransactionProgress(
	multisig: MultisigRow,
	tx: SavedMultisigTransaction
): MultisigSigningProgress | null {
	try {
		return multisigPsbtProgress(tx.psbt, multisig.threshold);
	} catch {
		return null;
	}
}

export interface BuildMultisigDraftInput {
	/** One or more outputs; 'max' only as the sole recipient's amount. */
	recipients: { address: string; amount: number | 'max' }[];
	feeRate: number;
	/** Manual coin control: restrict selection to these coins. */
	onlyUtxos?: { txid: string; vout: number }[];
}

/**
 * Build an unsigned multisig PSBT from live UTXOs and persist it as a draft.
 * Throws PsbtError (user-presentable message) on construction problems.
 *
 * The lifecycle skeleton — per-multisig lock (cairn QA R7 B4 follow-up),
 * unconfirmed-coin trust classification (cairn-u9ob.1), the coinbase-maturity
 * tip fetch (cairn-oae1.1), reservation exclusion + shortfall reframe (cairn
 * QA R7 B4), draft persistence, and the chain-depth/reservation warnings —
 * runs in spendLifecycle.executeBuildDraft, shared verbatim with the
 * single-sig side; this function supplies only what is multisig-specific:
 * the cosigner-reachable access gate, the vault's UTXO source, change-index
 * issuance, constructMultisigPsbt, and the roster freeze + notify hook.
 *
 * The lock key is deliberately a DIFFERENT namespace from
 * nextMultisigChangeIndex's own `multisig:${id}` withLock (multisigScan.ts):
 * an outer withLock on that same key would deadlock (nextMultisigChangeIndex
 * is called from inside this critical section) — `multisig-draft:` only needs
 * to serialize against ITSELF, not against change-index issuance.
 */
export async function buildMultisigDraft(
	userId: number,
	multisigId: number,
	input: BuildMultisigDraftInput
): Promise<{
	draft: SavedMultisigTransaction;
	details: ConstructedMultisigPsbt;
	chainDepthWarning: ChainDepthWarning | null;
	reservationWarning: ReservationWarning | null;
}> {
	return executeBuildDraft<MultisigRow, SavedMultisigTransaction, ConstructedMultisigPsbt>({
		spec: SPEC,
		ownerId: multisigId,
		lockKey: `multisig-draft:${multisigId}`,
		onlyUtxos: input.onlyUtxos,
		// A wallet-level cosigner (or the owner) may initiate a spend; the roster
		// frozen in onDraftSaved records who is then expected to sign it.
		prepare: () => signableMultisig(userId, multisigId),
		notFoundError: () => new PsbtError('Multisig not found.', 'construction_failed'),
		getUtxos: (multisig) => getMultisigUtxos(multisig),
		buildPsbt: async (multisig, { utxos, tipHeight }) => {
			const changeIndex = await nextMultisigChangeIndex(multisig);
			return constructMultisigPsbt({
				config: toMultisigConfig(multisig),
				utxos,
				recipients: input.recipients,
				feeRate: input.feeRate,
				// Node relay floor gates the fee (cairn-eacw.2) — same as the single-sig
				// buildDraft path; a sub-1 fee builds on a node that relays below 1.
				minFeeRate: await getChain().getMinFeeRate(),
				changeIndex,
				fetchRawTx: (txid) => getChain().getTxHex(txid),
				onlyUtxos: input.onlyUtxos,
				tipHeight
			});
		},
		reload: (rowId) => getMultisigTransaction(userId, multisigId, rowId),
		draftSaveError: () => new PsbtError('Draft could not be saved.', 'construction_failed'),
		// Freeze the signer roster and notify every member except the creator that
		// their signature is wanted — immediately, at creation (not deferred until
		// someone else signs). For a solo multisig the roster is just the owner, so
		// this notifies no one and costs a single cheap insert.
		onDraftSaved: (draft, multisig) => freezeRosterAndNotify(multisig, draft, userId)
	});
}

/** Raw lifecycle setter — the attach/broadcast paths below use it. */
export function updateMultisigTransaction(
	userId: number,
	multisigId: number,
	txId: number,
	fields: { status?: MultisigTxStatus; psbt?: string; txid?: string }
): SavedMultisigTransaction | null {
	const existing = getMultisigTransaction(userId, multisigId, txId);
	if (!existing) return null;

	updateSpendRow(SPEC, txId, fields);

	return getMultisigTransaction(userId, multisigId, txId);
}

/**
 * Merge one signer's output into the stored PSBT — the per-key attach step of
 * the signing stepper. Accepts anything a signer hands back (base64 / hex /
 * text-wrapped file), verifies it commits to the SAME transaction the user
 * reviewed, unions its partial signatures with what is already collected
 * (idempotent — re-submitting is harmless), and persists the merge. Returns
 * the updated row plus fresh quorum progress so the stepper can advance.
 *
 * Throws: InvalidPsbtError (corrupt file), Error('Not a PSBT'-family) from
 * normalizePsbt, MultisigPsbtError ('different_transaction' | 'foreign_signature')
 * from the combine, BroadcastError('already_sent') for finished rows.
 */
export function attachMultisigSignature(
	userId: number,
	multisigId: number,
	txId: number,
	signedPsbt: string
): { transaction: SavedMultisigTransaction; progress: MultisigSigningProgress } | null {
	const multisig = signableMultisig(userId, multisigId);
	const existing = multisig ? getMultisigTransaction(userId, multisigId, txId) : null;
	if (!multisig || !existing) return null;
	// Capture whether quorum was ALREADY met before this signature, so the
	// "ready to broadcast" notification fires exactly once — on the transition
	// into completeness, never on a redundant re-attach (cairn-5gpv.7).
	const wasComplete = multisigTransactionProgress(multisig, existing)?.complete === true;
	// Per-transaction roster gate. The owner is always an implicit roster member
	// (the plan §4) and signs the "remaining" keys, so they're allowed
	// unconditionally — never bricked even if the best-effort roster insert at
	// creation failed. A wallet-level COSIGNER, however, may only sign a
	// transaction whose frozen roster they are actually on (a share added after
	// this draft was created doesn't retroactively join its roster).
	if (multisig.userId !== userId && !isRosterMember(txId, userId)) return null;
	if (existing.status === 'completed' || existing.txid) {
		throw new BroadcastError('This transaction has already been broadcast.', 'already_sent');
	}

	const normalized = normalizePsbt(signedPsbt); // throws InvalidPsbtError / generic on garbage
	// combineMultisigPsbts enforces the same-transaction guard (a signer returning
	// a different payment is refused) and multisig-key membership per signature.
	const combined = combineMultisigPsbts(existing.psbt, normalized);

	const updated = updateMultisigTransaction(userId, multisigId, txId, {
		psbt: combined,
		status: 'awaiting_signature'
	});
	if (!updated) return null;
	const progress = multisigTransactionProgress(multisig, updated);
	if (!progress) {
		// Cannot happen for a PSBT that just combined cleanly, but never return
		// a success shape without real progress data.
		throw new MultisigPsbtError('The combined PSBT could not be re-read.', 'combine_failed');
	}

	// Reconcile the advisory roster against the real PSBT progress and notify any
	// members still owed a signature. Best-effort — never breaks the attach.
	notifyRosterProgress(multisig, updated, progress);
	// Quorum just reached: nudge the roster that it's ready to broadcast. Only on
	// the transition into completeness, so it never repeats (cairn-5gpv.7).
	if (progress.complete && !wasComplete) {
		notifySignSessionComplete(multisig, updated, progress);
	}

	return { transaction: updated, progress };
}

export function deleteMultisigTransaction(userId: number, multisigId: number, txId: number): boolean {
	// Draft management is owner-only — a cosigner can sign but not discard a
	// pending session out from under the owner and other signers.
	if (!getMultisig(userId, multisigId)) return false;
	if (!getMultisigTransaction(userId, multisigId, txId)) return false;
	// The atomic conditional DELETE (cairn-up0q TOCTOU fix + cairn-ytnc stale-
	// claim window) lives in spendLifecycle.deleteSpendDraft, shared with the
	// single-sig side. It also excludes 'superseded' rows — a superseded tx was
	// broadcast too (see the supersede step in the shared broadcast engine) and
	// deleting it would erase that record.
	return deleteSpendDraft(SPEC, multisigId, txId);
}

/**
 * Finalize a quorum-complete multisig PSBT and broadcast it. Refuses below
 * quorum with an "X of M signatures collected" message — quorum is judged
 * from the PSBT itself, never a stored counter. Optionally merges one last
 * signed PSBT first (a device flow may hand the final signature straight to
 * the broadcast step).
 *
 * The whole broadcast pipeline — already-sent guard, early/late duplicate
 * dedup (cairn QA R7 B4 sub-case 1), the atomic broadcast claim, package-relay
 * rescue (cairn-u9ob.8), reported-txid verification (cairn-ziwm), RBF
 * supersede bookkeeping, wallet-dirty marking (cairn-g1u2) — runs in
 * spendLifecycle.executeBroadcast, shared verbatim with the single-sig side.
 * This function supplies only what is multisig-specific: the owner-only
 * access gate, the ride-along signature merge through the normal attach path,
 * and the quorum gate + multisig finalization.
 */
export async function broadcastMultisigTransaction(
	userId: number,
	multisigId: number,
	txId: number,
	signedPsbt?: string
): Promise<{
	txid: string;
	transaction: SavedMultisigTransaction;
	duplicate?: boolean;
	message?: string;
}> {
	// Broadcast stays owner-only (plan §3, §8): a cosigner signs, only the owner
	// sends the fully-signed transaction to the network.
	const multisig = getMultisig(userId, multisigId);
	const tx = multisig ? getMultisigTransaction(userId, multisigId, txId) : null;
	if (!multisig || !tx) throw new BroadcastError('Transaction not found.', 'not_found');

	return executeBroadcast<SavedMultisigTransaction>({
		spec: SPEC,
		ownerId: multisigId,
		txId,
		tx,
		preparePsbt: (tx) => {
			// A final signature riding along with the broadcast request merges (and
			// persists) exactly like a normal attach — same guards, same idempotency.
			if (signedPsbt?.trim()) {
				let attached: ReturnType<typeof attachMultisigSignature>;
				try {
					attached = attachMultisigSignature(userId, multisigId, txId, signedPsbt);
				} catch (e) {
					if (e instanceof MultisigPsbtError && e.code === 'different_transaction') {
						throw new BroadcastError(e.message, 'mismatch');
					}
					if (e instanceof MultisigPsbtError) throw new BroadcastError(e.message, 'incomplete');
					if (e instanceof BroadcastError) throw e;
					throw new BroadcastError(
						e instanceof InvalidPsbtError ? e.message : "That doesn't look like a valid PSBT.",
						'incomplete'
					);
				}
				if (!attached) throw new BroadcastError('Transaction not found.', 'not_found');
				tx = attached.transaction;
			}
			return { psbt: tx.psbt, tx };
		},
		finalize: (psbt, tx) => {
			// Quorum gate: the PSBT itself is the authority. "1 of 2 signatures
			// collected" beats btc-signer's opaque finalize error every time.
			const progress = multisigTransactionProgress(multisig, tx);
			if (!progress) {
				throw new BroadcastError('The stored PSBT could not be read.', 'incomplete');
			}
			if (!progress.complete) {
				throw new BroadcastError(
					`Only ${progress.collected} of ${progress.required} signatures collected — this multisig needs ${progress.required} signatures to spend.`,
					'incomplete'
				);
			}

			try {
				return finalizeMultisigPsbt(psbt);
			} catch (e) {
				throw new BroadcastError(
					e instanceof Error ? e.message : 'This PSBT could not be finalized.',
					'incomplete'
				);
			}
		},
		reload: (rowId) => getMultisigTransaction(userId, multisigId, rowId)
	});
}

/**
 * Recover the exact coins a stored multisig PSBT spends, from the PSBT itself:
 * txid/vout from each input, value from witnessUtxo (segwit) or the referenced
 * output of the embedded nonWitnessUtxo (legacy p2sh), and the multisig
 * chain/index from the bip32Derivation Cairn embeds for every key (all N share
 * the same trailing chain/index). The address re-derives from the multisig
 * config at that chain/index. Throws BumpError when an input lacks the data
 * needed to rebuild it verbatim.
 */
function recoverMultisigPsbtInputs(
	tx: Transaction,
	config: ReturnType<typeof toMultisigConfig>
): SpendableUtxo[] {
	const utxos: SpendableUtxo[] = [];
	for (let i = 0; i < tx.inputsLength; i++) {
		const inp = tx.getInput(i);
		if (!inp.txid || inp.index === undefined) {
			throw new BumpError(
				'The stored transaction is missing input data and cannot be reconstructed.',
				'not_bumpable'
			);
		}
		let value: number | null = null;
		if (inp.witnessUtxo) {
			value = Number(inp.witnessUtxo.amount);
		} else if (inp.nonWitnessUtxo) {
			const prev = inp.nonWitnessUtxo.outputs[inp.index];
			if (prev) value = Number(prev.amount);
		}
		// Every multisig input carries one bip32Derivation per key; they all end in
		// the same (chain, index), so the first entry is authoritative.
		const path = inp.bip32Derivation?.[0]?.[1]?.path;
		const chainSeg = path?.[path.length - 2];
		const indexSeg = path?.[path.length - 1];
		if (
			value === null ||
			!((chainSeg === 0 || chainSeg === 1) && typeof indexSeg === 'number' && indexSeg >= 0)
		) {
			throw new BumpError(
				'The stored transaction does not carry enough coin data to rebuild it.',
				'not_bumpable'
			);
		}
		const chain = chainSeg as 0 | 1;
		utxos.push({
			txid: bytesToHex(inp.txid),
			vout: inp.index,
			value,
			// Height is irrelevant under exactInputs (no eligibility filtering); these
			// coins already funded a broadcast tx.
			height: 1,
			address: deriveMultisigAddress(config, chain, indexSeg).address,
			chain,
			index: indexSeg
		});
	}
	return utxos;
}

/**
 * Build a replace-by-fee (BIP-125) replacement for a broadcast-but-unconfirmed
 * multisig transaction: identical inputs, same recipients and amounts, a higher
 * fee taken entirely out of change. Saved as a fresh draft (replaces_txid → the
 * original's txid) that re-enters the normal roster sign-and-broadcast flow; the
 * original is marked 'superseded' only once the replacement actually broadcasts.
 * Owner-only — like broadcast and draft-delete (mirrors bumpTransaction).
 */
export async function bumpMultisigTransaction(
	userId: number,
	multisigId: number,
	txId: number,
	newFeeRate: number
): Promise<{ draft: SavedMultisigTransaction; details: ConstructedMultisigPsbt }> {
	const multisig = getMultisig(userId, multisigId);
	const tx = multisig ? getMultisigTransaction(userId, multisigId, txId) : null;
	if (!multisig || !tx) throw new BumpError('Transaction not found.', 'not_found');

	return executeRbfBump<SavedMultisigTransaction, ConstructedMultisigPsbt>({
		spec: SPEC,
		ownerId: multisigId,
		tx,
		newFeeRate,
		buildReplacement: async (stored, changeIndex, minFeeRate) => {
			const config = toMultisigConfig(multisig);
			const utxos = recoverMultisigPsbtInputs(stored, config);

			// Every recipient output is reproduced exactly (batch rows keep paying all
			// N); the fee increase comes solely out of change, over the identical
			// input set.
			try {
				return await constructMultisigPsbt({
					config,
					utxos,
					recipients: tx.recipients,
					feeRate: newFeeRate,
					// Node relay floor (cairn-eacw.2): don't reject a sub-1 bump before
					// BIP-125 rule 4 runs (which forces the effective rate up anyway).
					minFeeRate,
					changeIndex,
					fetchRawTx: (txid) => getChain().getTxHex(txid),
					exactInputs: true
				});
			} catch (e) {
				if (e instanceof PsbtError && e.code === 'insufficient_funds') {
					throw new BumpError(
						'The change output cannot absorb a fee increase at that rate — try a lower rate.',
						'fee_too_low'
					);
				}
				throw e;
			}
		},
		reloadDraft: (rowId) => getMultisigTransaction(userId, multisigId, rowId),
		draftSaveError: () => new BumpError('Replacement draft could not be saved.', 'not_bumpable'),
		// Freeze the roster and notify cosigners the replacement needs their
		// signature — same as a fresh draft. For a solo multisig this notifies no one.
		onDraftSaved: (draft) => freezeRosterAndNotify(multisig, draft, userId)
	});
}

/** Own txids this multisig broadcast — same own-change vs received signal the
 *  single-sig path uses (ownBroadcastTxids), against multisig_transactions. */
export function ownMultisigTxids(multisigId: number): Set<string> {
	return ownBroadcastedTxids(SPEC, multisigId);
}

/** Wallet-scoped stuck/incoming-tx detection (cairn-u9ob.2), multisig side.
 *  Viewer-reachable: seeing which of a vault's txs are stuck is a read. */
export async function detectMultisigUnconfirmedInflows(
	userId: number,
	multisigId: number
): Promise<UnconfirmedInflow[] | null> {
	const multisig = getViewableMultisig(userId, multisigId);
	if (!multisig) return null;
	const utxos = await getMultisigUtxos(multisig);
	return detectUnconfirmedInflows(utxos, ownMultisigTxids(multisigId));
}

/**
 * Multisig child-pays-for-parent (cairn-u9ob.6, parity with single-sig
 * buildCpfpDraft). Spends the vault's own unconfirmed output on a stuck parent,
 * sweeping it back to the vault's change address at a fee high enough that the
 * parent+child package averages `targetFeeRate`. A genuinely new draft (no
 * replaces_txid) that re-enters the normal roster sign/broadcast flow — the
 * parent stays exactly as broadcast. Fee math and guardrails are identical to
 * the single-sig path (docs/CPFP-UNCONFIRMED-PLAN.md §3), only the builder and
 * vsize table differ (multisig inputs are larger).
 */
export async function buildMultisigCpfpDraft(
	userId: number,
	multisigId: number,
	parentTxid: string,
	targetFeeRate: number
): Promise<{
	draft: SavedMultisigTransaction;
	details: ConstructedMultisigPsbt;
	cpfp: { parentVsize: number; parentFee: number; childFee: number; targetRate: number };
	chainDepthWarning: ChainDepthWarning | null;
}> {
	// Building a spend is cosigner-reachable (owner or role='cosigner'), same gate
	// as buildMultisigDraft — a CPFP child is just another spend to be signed.
	const multisig = getSignableMultisig(userId, multisigId);
	if (!multisig) throw new CpfpError('Multisig not found.', 'not_found');
	const config = toMultisigConfig(multisig);

	return executeCpfpDraft<SavedMultisigTransaction, ConstructedMultisigPsbt>({
		spec: SPEC,
		ownerId: multisigId,
		parentTxid,
		targetFeeRate,
		walletNoun: 'vault',
		getUtxos: () => getMultisigUtxos(multisig),
		prepareChild: async (qualifying) => {
			const changeIndex = await nextMultisigChangeIndex(multisig);
			const changeAddress = deriveMultisigAddress(config, 1, changeIndex).address;
			return {
				changeAddress,
				changeIndex,
				childVsize: estimateMultisigTxVsize(
					config.scriptType,
					config.threshold,
					config.keys.length,
					qualifying.length,
					[changeAddress]
				)
			};
		},
		buildChild: ({ qualifying, changeAddress, changeIndex, childRate, floor }) =>
			constructMultisigPsbt({
				config,
				utxos: qualifying,
				// Send-max sweeps exactly the coin-controlled set back to our own change.
				recipients: [{ address: changeAddress, amount: 'max' }],
				feeRate: childRate,
				// childRate is already clamped to this floor; pass it so a sub-1 child
				// isn't re-rejected by the default 1 sat/vB validation (cairn-eacw.2).
				minFeeRate: floor,
				changeIndex,
				fetchRawTx: (txid) => getChain().getTxHex(txid),
				onlyUtxos: qualifying.map((u) => ({ txid: u.txid, vout: u.vout }))
			}),
		isCoinTooSmall: (e) =>
			e instanceof PsbtError && (e.code === 'insufficient_funds' || e.code === 'no_utxos'),
		reloadDraft: (rowId) => getMultisigTransaction(userId, multisigId, rowId),
		draftSaveError: () => new CpfpError('CPFP draft could not be saved.', 'not_found'),
		// A CPFP child still needs the vault quorum to sign — freeze the roster and
		// notify, same as any other draft.
		onDraftSaved: (draft) => freezeRosterAndNotify(multisig, draft, userId)
	});
}
