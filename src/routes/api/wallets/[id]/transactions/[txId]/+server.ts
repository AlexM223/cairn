import { json } from '@sveltejs/kit';
import { requireUser, readJson } from '$lib/server/api';
import {
	getTransaction,
	updateTransaction,
	deleteTransaction,
	normalizePsbt
} from '$lib/server/transactions';
import { summarizePsbt, assertSameTransaction, PsbtMismatchError } from '$lib/server/bitcoin/psbt';
import type { PsbtSummary } from '$lib/server/bitcoin/psbt';
import type { RequestHandler } from './$types';

function ids(event: { params: { id: string; txId: string } }) {
	return { walletId: Number(event.params.id), txId: Number(event.params.txId) };
}

function safeSummary(psbt: string): PsbtSummary | null {
	try {
		return summarizePsbt(psbt);
	} catch {
		return null;
	}
}

/** GET a saved transaction with a parsed PSBT summary. */
export const GET: RequestHandler = async (event) => {
	const user = requireUser(event);
	const { walletId, txId } = ids(event);
	const tx = getTransaction(user.id, walletId, txId);
	if (!tx) return json({ error: 'Transaction not found' }, { status: 404 });
	return json({ transaction: tx, summary: safeSummary(tx.psbt) });
};

/**
 * PATCH a saved transaction: attach a signed PSBT (moving it to
 * awaiting-signature) or apply a lifecycle status. An uploaded PSBT must be
 * parseable AND describe the same payment as the stored draft — a stray file
 * from a different transaction is refused, not silently adopted.
 */
export const PATCH: RequestHandler = async (event) => {
	const user = requireUser(event);
	const { walletId, txId } = ids(event);
	const existing = getTransaction(user.id, walletId, txId);
	if (!existing) return json({ error: 'Transaction not found' }, { status: 404 });
	if (existing.status === 'completed')
		return json({ error: 'This transaction has already been broadcast.' }, { status: 409 });

	const body = await readJson<{ psbt?: string; status?: string }>(event);
	const fields: { psbt?: string; status?: 'draft' | 'awaiting_signature' } = {};

	if (typeof body.psbt === 'string') {
		let normalized: string;
		try {
			normalized = normalizePsbt(body.psbt);
		} catch {
			return json({ error: "That doesn't look like a valid PSBT." }, { status: 400 });
		}
		if (!safeSummary(normalized)) {
			return json({ error: "That doesn't look like a valid PSBT." }, { status: 400 });
		}
		// Refuse a PSBT that commits to different inputs/outputs than the draft
		// the user reviewed — a stray "signed.psbt" from another transaction
		// must never be adopted (and later broadcast) in its place.
		try {
			assertSameTransaction(existing.psbt, normalized);
		} catch (e) {
			return json(
				{
					error:
						e instanceof PsbtMismatchError
							? `${e.message} Double-check you picked the right file.`
							: 'That PSBT does not match this draft.',
					code: 'mismatch'
				},
				{ status: 400 }
			);
		}
		fields.psbt = normalized;
		fields.status = 'awaiting_signature';
	}
	if (body.status === 'draft' || body.status === 'awaiting_signature') {
		fields.status = body.status;
	}
	if (fields.psbt === undefined && fields.status === undefined) {
		return json({ error: 'Nothing to update.' }, { status: 400 });
	}

	const updated = updateTransaction(user.id, walletId, txId, fields);
	if (!updated) return json({ error: 'Transaction not found' }, { status: 404 });
	return json({ transaction: updated, summary: safeSummary(updated.psbt) });
};

/** DELETE a draft or awaiting-signature transaction (completed ones are kept). */
export const DELETE: RequestHandler = async (event) => {
	const user = requireUser(event);
	const { walletId, txId } = ids(event);
	const ok = deleteTransaction(user.id, walletId, txId);
	if (!ok)
		return json(
			{ error: 'Transaction not found, or already broadcast and kept for the record.' },
			{ status: 400 }
		);
	return json({ ok: true });
};
