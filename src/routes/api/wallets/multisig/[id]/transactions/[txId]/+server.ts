import { json } from '@sveltejs/kit';
import { requireUser, readJson } from '$lib/server/api';
import { getMultisig } from '$lib/server/wallets/multisig';
import {
	getMultisigTransaction,
	attachMultisigSignature,
	updateMultisigTransaction,
	deleteMultisigTransaction,
	multisigTransactionProgress
} from '$lib/server/multisigTransactions';
import { InvalidPsbtError, BroadcastError } from '$lib/server/transactions';
import { MultisigPsbtError } from '$lib/server/bitcoin/multisigPsbt';
import { summarizePsbt, type PsbtSummary } from '$lib/server/bitcoin/psbt';
import { childLogger } from '$lib/server/logger';
import type { RequestHandler } from './$types';

const log = childLogger('wallet');

function ids(event: { params: { id: string; txId: string } }) {
	return { multisigId: Number(event.params.id), txId: Number(event.params.txId) };
}

function safeSummary(psbt: string): PsbtSummary | null {
	try {
		return summarizePsbt(psbt);
	} catch {
		return null;
	}
}

/**
 * GET a saved multisig transaction with a PSBT summary AND the quorum progress
 * object — the single shape the signing stepper trusts (required, collected,
 * complete, signedFingerprints, remainingFingerprints).
 */
export const GET: RequestHandler = async (event) => {
	const user = requireUser(event);
	const { multisigId, txId } = ids(event);
	const multisig = getMultisig(user.id, multisigId);
	const tx = multisig ? getMultisigTransaction(user.id, multisigId, txId) : null;
	if (!multisig || !tx) return json({ error: 'Transaction not found' }, { status: 404 });
	return json({
		transaction: tx,
		summary: safeSummary(tx.psbt),
		progress: multisigTransactionProgress(multisig, tx)
	});
};

/**
 * PATCH: attach one signer's output. The server merges its partial signatures
 * into the stored PSBT (combineMultisigPsbts — idempotent, same-transaction
 * guarded, multisig-key validated) and returns the updated row plus fresh
 * progress so the stepper can advance to the next key or to Confirm.
 * A plain { status } body adjusts lifecycle state without touching the PSBT.
 */
export const PATCH: RequestHandler = async (event) => {
	const user = requireUser(event);
	const { multisigId, txId } = ids(event);
	const multisig = getMultisig(user.id, multisigId);
	const existing = multisig ? getMultisigTransaction(user.id, multisigId, txId) : null;
	if (!multisig || !existing) return json({ error: 'Transaction not found' }, { status: 404 });
	if (existing.status === 'completed')
		return json({ error: 'This transaction has already been broadcast.' }, { status: 409 });

	const body = await readJson<{ psbt?: string; status?: string }>(event);

	if (typeof body.psbt === 'string') {
		try {
			const result = attachMultisigSignature(user.id, multisigId, txId, body.psbt);
			if (!result) return json({ error: 'Transaction not found' }, { status: 404 });
			return json({
				transaction: result.transaction,
				summary: safeSummary(result.transaction.psbt),
				progress: result.progress
			});
		} catch (e) {
			if (e instanceof MultisigPsbtError) {
				// 'different_transaction' is the substitution guard; 'foreign_signature'
				// means a device outside this multisig signed. Both are user-actionable.
				const hint =
					e.code === 'different_transaction' ? ' Double-check you picked the right file.' : '';
				return json({ error: `${e.message}${hint}`, code: e.code }, { status: 400 });
			}
			if (e instanceof InvalidPsbtError) {
				return json({ error: e.message }, { status: 400 });
			}
			if (e instanceof BroadcastError && e.code === 'already_sent') {
				return json({ error: e.message }, { status: 409 });
			}
			log.error({ err: e }, 'wallet transaction update failed');
			return json({ error: "That doesn't look like a valid PSBT." }, { status: 400 });
		}
	}

	if (body.status === 'draft' || body.status === 'awaiting_signature') {
		const updated = updateMultisigTransaction(user.id, multisigId, txId, { status: body.status });
		if (!updated) return json({ error: 'Transaction not found' }, { status: 404 });
		return json({
			transaction: updated,
			summary: safeSummary(updated.psbt),
			progress: multisigTransactionProgress(multisig, updated)
		});
	}

	return json({ error: 'Nothing to update.' }, { status: 400 });
};

/** DELETE a draft or awaiting-signature transaction (completed ones are kept). */
export const DELETE: RequestHandler = async (event) => {
	const user = requireUser(event);
	const { multisigId, txId } = ids(event);
	const ok = deleteMultisigTransaction(user.id, multisigId, txId);
	if (!ok)
		return json(
			{ error: 'Transaction not found, or already broadcast and kept for the record.' },
			{ status: 400 }
		);
	return json({ ok: true });
};
