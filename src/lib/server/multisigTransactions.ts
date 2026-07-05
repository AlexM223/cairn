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

import { db } from './db';
import { getChain } from './chain';
import { getMultisig, toMultisigConfig, type MultisigRow } from './wallets/multisig';
import { getMultisigUtxos, nextMultisigChangeIndex } from './multisigScan';
import {
	constructMultisigPsbt,
	combineMultisigPsbts,
	multisigPsbtProgress,
	finalizeMultisigPsbt,
	MultisigPsbtError,
	type ConstructedMultisigPsbt,
	type MultisigSigningProgress
} from './bitcoin/multisigPsbt';
import { PsbtError } from './bitcoin/psbt';
import { normalizePsbt, InvalidPsbtError, BroadcastError } from './transactions';
import { freezeRosterAndNotify, notifyRosterProgress } from './multisigRoster';

export type MultisigTxStatus = 'draft' | 'awaiting_signature' | 'completed';

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
	createdAt: string;
	updatedAt: string;
}

function ownedMultisig(userId: number, multisigId: number): MultisigRow | null {
	return getMultisig(userId, multisigId);
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
		createdAt: r.created_at as string,
		updatedAt: r.updated_at as string
	};
}

export function getMultisigTransaction(
	userId: number,
	multisigId: number,
	txId: number
): SavedMultisigTransaction | null {
	if (!ownedMultisig(userId, multisigId)) return null;
	const row = db
		.prepare('SELECT * FROM multisig_transactions WHERE id = ? AND multisig_id = ?')
		.get(txId, multisigId) as Record<string, unknown> | undefined;
	return row ? mapRow(row) : null;
}

export function listMultisigTransactions(
	userId: number,
	multisigId: number
): SavedMultisigTransaction[] | null {
	if (!ownedMultisig(userId, multisigId)) return null;
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
	const multisig = ownedMultisig(userId, multisigId);
	if (!multisig) throw new PsbtError('Multisig not found.', 'construction_failed');

	const utxos = await getMultisigUtxos(multisig);
	const changeIndex = await nextMultisigChangeIndex(multisig);

	const details = await constructMultisigPsbt({
		config: toMultisigConfig(multisig),
		utxos,
		recipients: input.recipients,
		feeRate: input.feeRate,
		changeIndex,
		fetchRawTx: (txid) => getChain().getTxHex(txid),
		onlyUtxos: input.onlyUtxos
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
	const multisig = ownedMultisig(userId, multisigId);
	const existing = multisig ? getMultisigTransaction(userId, multisigId, txId) : null;
	if (!multisig || !existing) return null;
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

	return { transaction: updated, progress };
}

export function deleteMultisigTransaction(userId: number, multisigId: number, txId: number): boolean {
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
	const multisig = ownedMultisig(userId, multisigId);
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

	let broadcastTxid: string;
	try {
		broadcastTxid = await getChain().electrum.broadcast(finalized.rawHex);
	} catch (e) {
		// Release the claim: a failed broadcast must stay retryable.
		db.prepare('UPDATE multisig_transactions SET broadcast_started_at = NULL WHERE id = ?').run(txId);
		const raw = e instanceof Error ? e.message : String(e);
		throw new BroadcastError(`The network rejected this transaction: ${raw}`, 'rejected');
	}

	const updated = updateMultisigTransaction(userId, multisigId, txId, {
		status: 'completed',
		txid: broadcastTxid
	});

	return { txid: broadcastTxid, transaction: updated! };
}
