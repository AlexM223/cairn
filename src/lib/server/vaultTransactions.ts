// Vault-transaction lifecycle service: builds unsigned multisig PSBTs from a
// vault's live UTXO set and persists them through draft → awaiting-signature
// (one merged signature at a time, until quorum) → completed (broadcast).
//
// Mirrors transactions.ts deliberately — same lifecycle vocabulary, same
// atomic broadcast claim, same substitution guard — but against the parallel
// vault_transactions table (see db.ts for why parallel, not merged). The one
// structural difference from wallet sends: a stored PSBT here accumulates
// signatures across SEVERAL attach calls, merged by combineVaultPsbts, and
// broadcast refuses to proceed below the vault's M-of-N quorum.

import { db } from './db';
import { getChain } from './chain';
import { getVault, toVaultConfig, type VaultRow } from './vaults';
import { getVaultUtxos, nextVaultChangeIndex } from './vaultScan';
import {
	constructVaultPsbt,
	combineVaultPsbts,
	vaultPsbtProgress,
	finalizeVaultPsbt,
	VaultPsbtError,
	type ConstructedVaultPsbt,
	type VaultSigningProgress
} from './bitcoin/vaultPsbt';
import { PsbtError } from './bitcoin/psbt';
import { normalizePsbt, InvalidPsbtError, BroadcastError } from './transactions';

export type VaultTxStatus = 'draft' | 'awaiting_signature' | 'completed';

export interface SavedVaultTransaction {
	id: number;
	vaultId: number;
	status: VaultTxStatus;
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

function ownedVault(userId: number, vaultId: number): VaultRow | null {
	return getVault(userId, vaultId);
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

function mapRow(r: Record<string, unknown>): SavedVaultTransaction {
	return {
		id: r.id as number,
		vaultId: r.vault_id as number,
		status: r.status as VaultTxStatus,
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

export function getVaultTransaction(
	userId: number,
	vaultId: number,
	txId: number
): SavedVaultTransaction | null {
	if (!ownedVault(userId, vaultId)) return null;
	const row = db
		.prepare('SELECT * FROM vault_transactions WHERE id = ? AND vault_id = ?')
		.get(txId, vaultId) as Record<string, unknown> | undefined;
	return row ? mapRow(row) : null;
}

export function listVaultTransactions(
	userId: number,
	vaultId: number
): SavedVaultTransaction[] | null {
	if (!ownedVault(userId, vaultId)) return null;
	const rows = db
		.prepare('SELECT * FROM vault_transactions WHERE vault_id = ? ORDER BY created_at DESC, id DESC')
		.all(vaultId) as Record<string, unknown>[];
	return rows.map(mapRow);
}

/**
 * Quorum progress for a saved vault transaction — a thin ownership-scoped
 * wrapper over vaultPsbtProgress, the single progress authority. Null when
 * the stored PSBT cannot be parsed (callers own the "corrupt" presentation).
 */
export function vaultTransactionProgress(
	vault: VaultRow,
	tx: SavedVaultTransaction
): VaultSigningProgress | null {
	try {
		return vaultPsbtProgress(tx.psbt, vault.threshold);
	} catch {
		return null;
	}
}

export interface BuildVaultDraftInput {
	/** One or more outputs; 'max' only as the sole recipient's amount. */
	recipients: { address: string; amount: number | 'max' }[];
	feeRate: number;
	/** Manual coin control: restrict selection to these coins. */
	onlyUtxos?: { txid: string; vout: number }[];
}

/**
 * Build an unsigned vault PSBT from live UTXOs and persist it as a draft.
 * Throws PsbtError (user-presentable message) on construction problems.
 */
export async function buildVaultDraft(
	userId: number,
	vaultId: number,
	input: BuildVaultDraftInput
): Promise<{ draft: SavedVaultTransaction; details: ConstructedVaultPsbt }> {
	const vault = ownedVault(userId, vaultId);
	if (!vault) throw new PsbtError('Vault not found.', 'construction_failed');

	const utxos = await getVaultUtxos(vault);
	const changeIndex = await nextVaultChangeIndex(vault);

	const details = await constructVaultPsbt({
		config: toVaultConfig(vault),
		utxos,
		recipients: input.recipients,
		feeRate: input.feeRate,
		changeIndex,
		fetchRawTx: (txid) => getChain().getTxHex(txid),
		onlyUtxos: input.onlyUtxos
	});

	const res = db
		.prepare(
			`INSERT INTO vault_transactions (vault_id, status, psbt, recipient, amount, fee, fee_rate, change_index, recipients)
			 VALUES (?, 'draft', ?, ?, ?, ?, ?, ?, ?)`
		)
		.run(
			vaultId,
			details.psbtBase64,
			details.recipient,
			details.amount,
			details.fee,
			details.feeRate,
			details.change?.index ?? null,
			recipientsJson(details.recipients)
		);

	const draft = getVaultTransaction(userId, vaultId, Number(res.lastInsertRowid));
	if (!draft) throw new PsbtError('Draft could not be saved.', 'construction_failed');
	return { draft, details };
}

/** Raw lifecycle setter — the attach/broadcast paths below use it. */
export function updateVaultTransaction(
	userId: number,
	vaultId: number,
	txId: number,
	fields: { status?: VaultTxStatus; psbt?: string; txid?: string }
): SavedVaultTransaction | null {
	const existing = getVaultTransaction(userId, vaultId, txId);
	if (!existing) return null;

	db.prepare(
		`UPDATE vault_transactions
		 SET status = COALESCE(?, status),
		     psbt = COALESCE(?, psbt),
		     txid = COALESCE(?, txid),
		     updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
		 WHERE id = ?`
	).run(fields.status ?? null, fields.psbt ?? null, fields.txid ?? null, txId);

	return getVaultTransaction(userId, vaultId, txId);
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
 * normalizePsbt, VaultPsbtError ('different_transaction' | 'foreign_signature')
 * from the combine, BroadcastError('already_sent') for finished rows.
 */
export function attachVaultSignature(
	userId: number,
	vaultId: number,
	txId: number,
	signedPsbt: string
): { transaction: SavedVaultTransaction; progress: VaultSigningProgress } | null {
	const vault = ownedVault(userId, vaultId);
	const existing = vault ? getVaultTransaction(userId, vaultId, txId) : null;
	if (!vault || !existing) return null;
	if (existing.status === 'completed' || existing.txid) {
		throw new BroadcastError('This transaction has already been broadcast.', 'already_sent');
	}

	const normalized = normalizePsbt(signedPsbt); // throws InvalidPsbtError / generic on garbage
	// combineVaultPsbts enforces the same-transaction guard (a signer returning
	// a different payment is refused) and vault-key membership per signature.
	const combined = combineVaultPsbts(existing.psbt, normalized);

	const updated = updateVaultTransaction(userId, vaultId, txId, {
		psbt: combined,
		status: 'awaiting_signature'
	});
	if (!updated) return null;
	const progress = vaultTransactionProgress(vault, updated);
	if (!progress) {
		// Cannot happen for a PSBT that just combined cleanly, but never return
		// a success shape without real progress data.
		throw new VaultPsbtError('The combined PSBT could not be re-read.', 'combine_failed');
	}
	return { transaction: updated, progress };
}

export function deleteVaultTransaction(userId: number, vaultId: number, txId: number): boolean {
	const tx = getVaultTransaction(userId, vaultId, txId);
	if (!tx) return false;
	// Completed transactions are history — the record that a broadcast happened.
	if (tx.status === 'completed') return false;
	db.prepare('DELETE FROM vault_transactions WHERE id = ?').run(txId);
	return true;
}

/**
 * Finalize a quorum-complete vault PSBT and broadcast it. Refuses below
 * quorum with an "X of M signatures collected" message — quorum is judged
 * from the PSBT itself, never a stored counter. Optionally merges one last
 * signed PSBT first (a device flow may hand the final signature straight to
 * the broadcast step). Uses the same atomic broadcast claim as wallet sends:
 * one guarded UPDATE lets exactly one concurrent caller through, and a failed
 * network send releases the claim so the user can retry.
 */
export async function broadcastVaultTransaction(
	userId: number,
	vaultId: number,
	txId: number,
	signedPsbt?: string
): Promise<{ txid: string; transaction: SavedVaultTransaction }> {
	const vault = ownedVault(userId, vaultId);
	let tx = vault ? getVaultTransaction(userId, vaultId, txId) : null;
	if (!vault || !tx) throw new BroadcastError('Transaction not found.', 'not_found');
	if (tx.status === 'completed' || tx.txid) {
		throw new BroadcastError('This transaction has already been broadcast.', 'already_sent');
	}

	// A final signature riding along with the broadcast request merges (and
	// persists) exactly like a normal attach — same guards, same idempotency.
	if (signedPsbt?.trim()) {
		let attached: ReturnType<typeof attachVaultSignature>;
		try {
			attached = attachVaultSignature(userId, vaultId, txId, signedPsbt);
		} catch (e) {
			if (e instanceof VaultPsbtError && e.code === 'different_transaction') {
				throw new BroadcastError(e.message, 'mismatch');
			}
			if (e instanceof VaultPsbtError) throw new BroadcastError(e.message, 'incomplete');
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
	const progress = vaultTransactionProgress(vault, tx);
	if (!progress) {
		throw new BroadcastError('The stored PSBT could not be read.', 'incomplete');
	}
	if (!progress.complete) {
		throw new BroadcastError(
			`Only ${progress.collected} of ${progress.required} signatures collected — this vault needs ${progress.required} signatures to spend.`,
			'incomplete'
		);
	}

	let finalized: { rawHex: string; txid: string };
	try {
		finalized = finalizeVaultPsbt(tx.psbt);
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
			`UPDATE vault_transactions
			 SET broadcast_started_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
			     updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
			 WHERE id = ? AND vault_id = ? AND txid IS NULL AND status != 'completed'
			   AND (broadcast_started_at IS NULL
			        OR broadcast_started_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-60 seconds'))`
		)
		.run(txId, vaultId);
	if (Number(claimed.changes) === 0) {
		throw new BroadcastError('This transaction has already been broadcast.', 'already_sent');
	}

	let broadcastTxid: string;
	try {
		broadcastTxid = await getChain().electrum.broadcast(finalized.rawHex);
	} catch (e) {
		// Release the claim: a failed broadcast must stay retryable.
		db.prepare('UPDATE vault_transactions SET broadcast_started_at = NULL WHERE id = ?').run(txId);
		const raw = e instanceof Error ? e.message : String(e);
		throw new BroadcastError(`The network rejected this transaction: ${raw}`, 'rejected');
	}

	const updated = updateVaultTransaction(userId, vaultId, txId, {
		status: 'completed',
		txid: broadcastTxid
	});

	return { txid: broadcastTxid, transaction: updated! };
}
