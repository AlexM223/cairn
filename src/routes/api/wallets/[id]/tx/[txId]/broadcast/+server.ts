import { json } from '@sveltejs/kit';
import { requireUser, readJson } from '$lib/server/api';
import { broadcastTransaction, BroadcastError } from '$lib/server/transactions';
import type { RequestHandler } from './$types';

/**
 * Finalize and broadcast a saved transaction. Optionally accepts a freshly
 * signed PSBT in the body (e.g. straight from an in-browser device flow)
 * which is finalized in place. Refuses transactions that already have a txid.
 */
export const POST: RequestHandler = async (event) => {
	const user = requireUser(event);
	const walletId = Number(event.params.id);
	const txId = Number(event.params.txId);

	const body = await readJson<{ psbt?: string }>(event).catch(() => ({ psbt: undefined }));

	try {
		const { txid, transaction } = await broadcastTransaction(
			user.id,
			walletId,
			txId,
			typeof body.psbt === 'string' ? body.psbt : undefined
		);
		return json({ txid, transaction });
	} catch (e) {
		if (e instanceof BroadcastError) {
			const status =
				e.code === 'not_found' ? 404 : e.code === 'already_sent' ? 409 : 400;
			return json({ error: e.message, code: e.code }, { status });
		}
		return json(
			{ error: e instanceof Error ? e.message : 'Broadcast failed' },
			{ status: 502 }
		);
	}
};
