import { json } from '@sveltejs/kit';
import { requireUser, readOptionalJson } from '$lib/server/api';
import { broadcastTransaction, BroadcastError } from '$lib/server/transactions';
import type { RequestHandler } from './$types';
import { childLogger } from '$lib/server/logger';

const log = childLogger('wallet');

/**
 * Finalize and broadcast a saved transaction. Optionally accepts a freshly
 * signed PSBT in the body, which must describe the same payment as the saved
 * draft (verified server-side). Refuses transactions that already have a txid.
 */
export const POST: RequestHandler = async (event) => {
	const user = requireUser(event);
	const walletId = Number(event.params.id);
	const txId = Number(event.params.txId);

	const body = await readOptionalJson<{ psbt?: string }>(event);

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
		log.error({ err: e, walletId, txId }, 'wallet broadcast failed');
		return json(
			{ error: e instanceof Error ? e.message : 'Broadcast failed' },
			{ status: 502 }
		);
	}
};
