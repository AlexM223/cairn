// Multisig-transaction lifecycle service: builds unsigned multisig PSBTs from a
// multisig's live UTXO set and persists them through draft → awaiting-signature
// (one merged signature at a time, until quorum) → completed (broadcast).
//
// Mirrors transactions.ts deliberately — same lifecycle vocabulary, same
// atomic broadcast claim, same substitution guard — but against the parallel
// multisig_transactions table (see db.ts for why parallel, not merged). The one
// structural difference from wallet sends: a stored PSBT here accumulates
// signatures across SEVERAL attach calls, merged by combineMultisigPsbts, and
// broadcast refuses to proceed below the multisig's M-of-N quorum.

import { Transaction } from '@scure/btc-signer';
import { base64 } from '@scure/base';
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
import { PsbtError, MAX_FEE_RATE, type SpendableUtxo } from './bitcoin/psbt';
import {
	normalizePsbt,
	InvalidPsbtError,
	BroadcastError,
	BumpError,
	CpfpError,
	cpfpChildFee,
	detectUnconfirmedInflows,
	classifyUnconfirmedTrust,
	type UnconfirmedInflow
} from './transactions';

export type MultisigTxStatus = 'draft' | 'awaiting_signature' | 'completed' | 'superseded';

/** BIP-125 signaling threshold: any input sequence below this opts in to RBF.
 *  Mirrors transactions.ts (the constant is module-private there). */
const RBF_SIGNAL_MAX_SEQUENCE = 0xfffffffe;

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

// Access tiers (see docs/COLLABORATIVE-CUSTODY-PLAN.md §3): reading a
// transaction is a viewer-reachable surface (owner, viewer, or cosigner);
// building/signing is cosigner-reachable (owner or role='cosigner'); broadcast
// stays owner-only (gated at its call site with getMultisig directly). Every
// gate returns null for a non-participant exactly like a missing wallet, so
// callers surface a uniform 404 and never leak a wallet's existence.
function viewableMultisig(userId: number, multisigId: number): MultisigRow | null {
	return getViewableMultisig(userId, multisigId);
}

function signableMultisig(userId: number, multisigId: number): MultisigRow | null {
	return getSignableMultisig(userId, multisigId);
}

function recipientsJson(recipients: { address: string; amount: number }[]): string | null {
	return recipients.length > 1 ? JSON.stringify(recipients) : null;
}

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
	if (!viewableMultisig(userId, multisigId)) return null;
	const row = db
		.prepare('SELECT * FROM multisig_transactions WHERE id = ? AND multisig_id = ?')
		.get(txId, multisigId) as Record<string, unknown> | undefined;
	return row ? mapRow(row) : null;
}

export function listMultisigTransactions(
	userId: number,
	multisigId: number
): SavedMultisigTransaction[] | null {
	if (!viewableMultisig(userId, multisigId)) return null;
	const rows = db
		.prepare('SELECT * FROM multisig_transactions WHERE multisig_id = ? ORDER BY created_at DESC, id DESC')
		.all(multisigId) as Record<string, unknown>[];
	return rows.map(mapRow);
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
 */
export async function buildMultisigDraft(
	userId: number,
	multisigId: number,
	input: BuildMultisigDraftInput
): Promise<{ draft: SavedMultisigTransaction; details: ConstructedMultisigPsbt }> {
	// A wallet-level cosigner (or the owner) may initiate a spend; the roster
	// frozen just below records who is then expected to sign it.
	const multisig = signableMultisig(userId, multisigId);
	if (!multisig) throw new PsbtError('Multisig not found.', 'construction_failed');

	// Classify unconfirmed coins so selection can spend our own change but never
	// auto-select a stranger's unconfirmed coin (cairn-u9ob.1).
	const ownTxids = new Set(
		(
			db
				.prepare(
					"SELECT txid FROM multisig_transactions WHERE multisig_id = ? AND txid IS NOT NULL"
				)
				.all(multisigId) as { txid: string }[]
		).map((r) => r.txid.toLowerCase())
	);
	const utxos = classifyUnconfirmedTrust(await getMultisigUtxos(multisig), ownTxids);
	const changeIndex = await nextMultisigChangeIndex(multisig);
	// Only fetch the tip (for the coinbase-maturity guard) when a coinbase coin is
	// present, and never let a transient tip failure block an ordinary send.
	let tipHeight: number | undefined;
	if (utxos.some((u) => u.coinbase)) {
		try {
			tipHeight = (await getChain().getTip()).height;
		} catch {
			tipHeight = undefined;
		}
	}

	const details = await constructMultisigPsbt({
		config: toMultisigConfig(multisig),
		utxos,
		recipients: input.recipients,
		feeRate: input.feeRate,
		changeIndex,
		fetchRawTx: (txid) => getChain().getTxHex(txid),
		onlyUtxos: input.onlyUtxos,
		tipHeight
	});

	const res = db
		.prepare(
			`INSERT INTO multisig_transactions (multisig_id, status, psbt, recipient, amount, fee, fee_rate, change_index, recipients)
			 VALUES (?, 'draft', ?, ?, ?, ?, ?, ?, ?)`
		)
		.run(
			multisigId,
			details.psbtBase64,
			details.recipient,
			details.amount,
			details.fee,
			details.feeRate,
			details.change?.index ?? null,
			recipientsJson(details.recipients)
		);

	const draft = getMultisigTransaction(userId, multisigId, Number(res.lastInsertRowid));
	if (!draft) throw new PsbtError('Draft could not be saved.', 'construction_failed');

	// Freeze the signer roster and notify every member except the creator that
	// their signature is wanted — immediately, at creation (not deferred until
	// someone else signs). For a solo multisig the roster is just the owner, so
	// this notifies no one and costs a single cheap insert.
	freezeRosterAndNotify(multisig, draft, userId);

	return { draft, details };
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

	db.prepare(
		`UPDATE multisig_transactions
		 SET status = COALESCE(?, status),
		     psbt = COALESCE(?, psbt),
		     txid = COALESCE(?, txid),
		     updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
		 WHERE id = ?`
	).run(fields.status ?? null, fields.psbt ?? null, fields.txid ?? null, txId);

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
	const tx = getMultisigTransaction(userId, multisigId, txId);
	if (!tx) return false;
	// Completed transactions are history — the record that a broadcast happened.
	if (tx.status === 'completed') return false;
	db.prepare('DELETE FROM multisig_transactions WHERE id = ?').run(txId);
	return true;
}

/**
 * Finalize a quorum-complete multisig PSBT and broadcast it. Refuses below
 * quorum with an "X of M signatures collected" message — quorum is judged
 * from the PSBT itself, never a stored counter. Optionally merges one last
 * signed PSBT first (a device flow may hand the final signature straight to
 * the broadcast step). Uses the same atomic broadcast claim as wallet sends:
 * one guarded UPDATE lets exactly one concurrent caller through, and a failed
 * network send releases the claim so the user can retry.
 */
export async function broadcastMultisigTransaction(
	userId: number,
	multisigId: number,
	txId: number,
	signedPsbt?: string
): Promise<{ txid: string; transaction: SavedMultisigTransaction }> {
	// Broadcast stays owner-only (plan §3, §8): a cosigner signs, only the owner
	// sends the fully-signed transaction to the network.
	const multisig = getMultisig(userId, multisigId);
	let tx = multisig ? getMultisigTransaction(userId, multisigId, txId) : null;
	if (!multisig || !tx) throw new BroadcastError('Transaction not found.', 'not_found');
	if (tx.status === 'completed' || tx.txid) {
		throw new BroadcastError('This transaction has already been broadcast.', 'already_sent');
	}

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

	let finalized: { rawHex: string; txid: string };
	try {
		finalized = finalizeMultisigPsbt(tx.psbt);
	} catch (e) {
		throw new BroadcastError(
			e instanceof Error ? e.message : 'This PSBT could not be finalized.',
			'incomplete'
		);
	}

	// Atomically claim the broadcast before touching the network — identical
	// idiom to transactions.ts: the friendly checks above are racy on their
	// own; this single guarded UPDATE lets exactly one caller through, and a
	// stale claim (crash mid-broadcast) expires after 60s.
	const claimed = db
		.prepare(
			`UPDATE multisig_transactions
			 SET broadcast_started_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
			     updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
			 WHERE id = ? AND multisig_id = ? AND txid IS NULL AND status != 'completed'
			   AND (broadcast_started_at IS NULL
			        OR broadcast_started_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-60 seconds'))`
		)
		.run(txId, multisigId);
	if (Number(claimed.changes) === 0) {
		throw new BroadcastError('This transaction has already been broadcast.', 'already_sent');
	}

	let reportedTxid: string;
	try {
		reportedTxid = await getChain().electrum.broadcast(finalized.rawHex);
	} catch (e) {
		// Release the claim: a failed broadcast must stay retryable.
		db.prepare('UPDATE multisig_transactions SET broadcast_started_at = NULL WHERE id = ?').run(txId);
		const raw = e instanceof Error ? e.message : String(e);
		throw new BroadcastError(`The network rejected this transaction: ${raw}`, 'rejected');
	}

	// A malicious or misbehaving Electrum server can return an arbitrary txid for
	// a broadcast it never performed. finalized.txid is the double-SHA256 of the
	// exact bytes we sent — recomputed locally, it can't be forged. On a mismatch,
	// don't trust that the broadcast happened: release the claim (keep it
	// retryable) and refuse to record a bogus txid (cairn-ziwm).
	if (reportedTxid.trim().toLowerCase() !== finalized.txid.toLowerCase()) {
		db.prepare('UPDATE multisig_transactions SET broadcast_started_at = NULL WHERE id = ?').run(txId);
		throw new BroadcastError(
			'The server acknowledged the broadcast with a different transaction id than the one we signed — refusing to record it. Check your Electrum server and try again.',
			'rejected'
		);
	}
	const broadcastTxid = finalized.txid;

	const updated = updateMultisigTransaction(userId, multisigId, txId, {
		status: 'completed',
		txid: broadcastTxid
	});

	// A broadcast RBF replacement supersedes the transaction it replaced: mark the
	// original 'superseded' so the UI stops offering to sign/bump a tx the network
	// has now replaced (mirrors transactions.ts). Best-effort — never fails the
	// broadcast that already succeeded.
	if (updated?.replacesTxid) {
		try {
			db.prepare(
				`UPDATE multisig_transactions
				 SET status = 'superseded', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
				 WHERE multisig_id = ? AND txid = ? AND status != 'superseded'`
			).run(multisigId, updated.replacesTxid);
		} catch {
			/* superseded bookkeeping is cosmetic; the replacement is already sent */
		}
	}

	return { txid: broadcastTxid, transaction: updated! };
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

	if (tx.status === 'superseded') {
		throw new BumpError('This transaction was already replaced by a fee bump.', 'superseded');
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
		.prepare(
			'SELECT id, status FROM multisig_transactions WHERE multisig_id = ? AND replaces_txid = ?'
		)
		.get(multisigId, tx.txid) as { id: number; status: string } | undefined;
	if (existing) {
		throw new BumpError(
			existing.status === 'completed'
				? 'This transaction was already replaced by a fee bump.'
				: 'A replacement for this transaction is already in progress — finish or discard it first.',
			'already_replaced'
		);
	}

	// A confirmed transaction is final — no fee to bump. A failed lookup (mempool
	// eviction, backend outage) does not block: a replacement draft is harmless.
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

	// BIP-125 rule 1: every input must signal replaceability. constructMultisigPsbt
	// sets RBF_SEQUENCE on all inputs, but a hand-imported PSBT might not — the
	// network would silently ignore a replacement, so refuse up front.
	for (let i = 0; i < stored.inputsLength; i++) {
		if ((stored.getInput(i).sequence ?? 0xffffffff) >= RBF_SIGNAL_MAX_SEQUENCE) {
			throw new BumpError(
				"This transaction doesn't signal RBF (replace-by-fee), so the network won't accept a replacement — it can't be fee-bumped.",
				'not_rbf'
			);
		}
	}

	// The fee increase comes out of change; a changeless original has nowhere to
	// take it from without shortchanging a recipient.
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

	const config = toMultisigConfig(multisig);
	const utxos = recoverMultisigPsbtInputs(stored, config);

	// Every recipient output is reproduced exactly (batch rows keep paying all N);
	// the fee increase comes solely out of change, over the identical input set.
	let details: ConstructedMultisigPsbt;
	try {
		details = await constructMultisigPsbt({
			config,
			utxos,
			recipients: tx.recipients,
			feeRate: newFeeRate,
			changeIndex: tx.changeIndex,
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

	// BIP-125 rule 4: the replacement must pay for its own relay — at least the
	// original's fee plus (replacement vsize × 1 sat/vB incremental relay fee).
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
			`INSERT INTO multisig_transactions (multisig_id, status, psbt, recipient, amount, fee, fee_rate, change_index, replaces_txid, recipients)
			 VALUES (?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?)`
		)
		.run(
			multisigId,
			details.psbtBase64,
			details.recipient,
			details.amount,
			details.fee,
			details.feeRate,
			details.change?.index ?? null,
			tx.txid,
			recipientsJson(details.recipients)
		);

	const draft = getMultisigTransaction(userId, multisigId, Number(res.lastInsertRowid));
	if (!draft) throw new BumpError('Replacement draft could not be saved.', 'not_bumpable');

	// Freeze the roster and notify cosigners the replacement needs their signature —
	// same as a fresh draft. For a solo multisig this notifies no one.
	freezeRosterAndNotify(multisig, draft, userId);

	return { draft, details };
}

/** Own txids this multisig broadcast — same own-change vs received signal the
 *  single-sig path uses (ownBroadcastTxids), against multisig_transactions. */
function ownMultisigTxids(multisigId: number): Set<string> {
	const rows = db
		.prepare(
			"SELECT txid FROM multisig_transactions WHERE multisig_id = ? AND txid IS NOT NULL"
		)
		.all(multisigId) as { txid: string }[];
	return new Set(rows.map((r) => r.txid.toLowerCase()));
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
}> {
	// Building a spend is cosigner-reachable (owner or role='cosigner'), same gate
	// as buildMultisigDraft — a CPFP child is just another spend to be signed.
	const multisig = getSignableMultisig(userId, multisigId);
	if (!multisig) throw new CpfpError('Multisig not found.', 'not_found');

	// Cap the target at constructMultisigPsbt's ceiling — this builder is a caller
	// of it, not a bypass of its validation.
	const targetRate = Math.min(Number.isFinite(targetFeeRate) ? targetFeeRate : 0, MAX_FEE_RATE);
	if (targetRate < 1) {
		throw new CpfpError('The target fee rate must be at least 1 sat/vB.', 'not_needed');
	}

	// The qualifying coins: this vault's own UNCONFIRMED outputs on the parent.
	const qualifying = (await getMultisigUtxos(multisig)).filter(
		(u) => u.txid.toLowerCase() === parentTxid.toLowerCase() && u.height <= 0
	);
	if (qualifying.length === 0) {
		throw new CpfpError(
			'This vault has no unconfirmed output on that transaction to bump — CPFP needs a coin you can spend from the stuck transaction.',
			'no_unconfirmed_output'
		);
	}

	// The parent's real vsize + fee (esplora provides both). A confirmed parent has
	// nothing left to accelerate.
	let parentVsize: number;
	let parentFee: number;
	try {
		const parent = await getChain().getTx(parentTxid);
		if (parent.confirmed) {
			throw new CpfpError('That transaction has already confirmed — no CPFP needed.', 'already_confirmed');
		}
		if (parent.fee == null) {
			throw new CpfpError(
				"The parent transaction's fee is unknown, so the CPFP fee can't be computed.",
				'parent_fee_unknown'
			);
		}
		parentVsize = parent.vsize;
		parentFee = parent.fee;
	} catch (e) {
		if (e instanceof CpfpError) throw e;
		throw new CpfpError(
			'The parent transaction could not be looked up right now — try again in a moment.',
			'parent_unavailable'
		);
	}

	const config = toMultisigConfig(multisig);
	const changeIndex = await nextMultisigChangeIndex(multisig);
	const changeAddress = deriveMultisigAddress(config, 1, changeIndex).address;
	const childVsize = estimateMultisigTxVsize(
		config.scriptType,
		config.threshold,
		config.keys.length,
		qualifying.length,
		[changeAddress]
	);

	const childFee = cpfpChildFee(targetRate, parentVsize, parentFee, childVsize);
	// A non-positive raw child fee means the parent already meets the target.
	if (Math.ceil(targetRate * (parentVsize + childVsize)) - parentFee <= 0) {
		throw new CpfpError(
			`That transaction already pays about ${Math.round(parentFee / parentVsize)} sat/vB, which meets your ${Math.round(targetRate)} sat/vB target — no CPFP is needed.`,
			'not_needed'
		);
	}

	// The child's OWN rate is what constructMultisigPsbt prices with; clamp to
	// [1, MAX_FEE_RATE]. Because estimateMultisigTxVsize uses the same tables the
	// builder does, the swept tx's vsize matches childVsize, so the fee lands on childFee.
	const childRate = Math.min(Math.max(childFee / childVsize, 1), MAX_FEE_RATE);

	let details: ConstructedMultisigPsbt;
	try {
		details = await constructMultisigPsbt({
			config,
			utxos: qualifying,
			// Send-max sweeps exactly the coin-controlled set back to our own change.
			recipients: [{ address: changeAddress, amount: 'max' }],
			feeRate: childRate,
			changeIndex,
			fetchRawTx: (txid) => getChain().getTxHex(txid),
			onlyUtxos: qualifying.map((u) => ({ txid: u.txid, vout: u.vout }))
		});
	} catch (e) {
		if (e instanceof PsbtError && (e.code === 'insufficient_funds' || e.code === 'no_utxos')) {
			throw new CpfpError(
				'That unconfirmed coin is too small to pay the fee needed to accelerate the parent at this rate — lower the target rate or wait for a confirmation.',
				'coin_too_small'
			);
		}
		throw e;
	}

	const res = db
		.prepare(
			`INSERT INTO multisig_transactions (multisig_id, status, psbt, recipient, amount, fee, fee_rate, change_index, recipients)
			 VALUES (?, 'draft', ?, ?, ?, ?, ?, ?, ?)`
		)
		.run(
			multisigId,
			details.psbtBase64,
			details.recipient,
			details.amount,
			details.fee,
			details.feeRate,
			details.change?.index ?? null,
			recipientsJson(details.recipients)
		);

	const draft = getMultisigTransaction(userId, multisigId, Number(res.lastInsertRowid));
	if (!draft) throw new CpfpError('CPFP draft could not be saved.', 'not_found');

	// A CPFP child still needs the vault quorum to sign — freeze the roster and
	// notify, same as any other draft.
	freezeRosterAndNotify(multisig, draft, userId);

	return { draft, details, cpfp: { parentVsize, parentFee, childFee: details.fee, targetRate } };
}
