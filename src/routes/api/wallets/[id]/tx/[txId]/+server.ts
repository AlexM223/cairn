import { json } from '@sveltejs/kit';
import { requireUser, readJson } from '$lib/server/api';
import {
	getTransaction,
	updateTransaction,
	deleteTransaction
} from '$lib/server/transactions';
import { summarizePsbt } from '$lib/server/bitcoin/psbt';
import type { RequestHandler } from './$types';

function ids(event: { params: { id: string; txId: string } }) {
	return { walletId: Number(event.params.id), txId: Number(event.params.txId) };
}

/** GET a saved transaction with a parsed PSBT summary. */
export const GET: RequestHandler = async (event) => {
	const user = requireUser(event);
	const { walletId, txId } = ids(event);
	const tx = getTransaction(user.id, walletId, txId);
	if (!tx) return json({ error: 'Transaction not found' }, { status: 404 });

	let summary = null;
	try {
		summary = summarizePsbt(tx.psbt);
	} catch {
		summary = null;
	}
	return json({ transaction: tx, summary });
};

/**
 * PATCH a saved transaction: attach a signed PSBT (moving it to
 * awaiting-signature) or apply a lifecycle status. Signed PSBTs are validated
 * as parseable before they're stored.
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
		try {
			summarizePsbt(body.psbt); // reject unparseable input before storing
		} catch {
			return json({ error: "That doesn't look like a valid PSBT." }, { status: 400 });
		}
		fields.psbt = body.psbt.trim();
		fields.status = 'awaiting_signature';
	}
	if (body.status === 'draft' || body.status === 'awaiting_signature') {
		fields.status = body.status;
	}

	const updated = updateTransaction(user.id, walletId, txId, fields);
	return json({ transaction: updated });
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
