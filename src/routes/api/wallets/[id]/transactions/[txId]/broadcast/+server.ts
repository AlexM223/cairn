import { json } from '@sveltejs/kit';
import { requireFeature, readOptionalJson } from '$lib/server/api';
import { broadcastTransaction, BroadcastError } from '$lib/server/transactions';
import type { RequestHandler } from './$types';
import { childLogger } from '$lib/server/logger';

const log = childLogger('wallet');

/**
 * Finalize and broadcast a saved transaction. Optionally accepts a freshly
 * signed PSBT in the body, which must describe the same payment as the saved
 * draft (verified server-side). Refuses transactions that already have a txid.
 *
 * `duplicate`/`message` (cairn QA R7 B4 sub-case 1) are present when this
 * draft's finalized transaction is byte-identical to one another draft of
 * this wallet already broadcast: no second network send happens, and this
 * row is recorded as a duplicate rather than a second completed send.
 */
export const POST: RequestHandler = async (event) => {
	// Gate broadcasting behind the 'send' feature flag.
	const user = requireFeature(event, 'send');
	const walletId = Number(event.params.id);
	const txId = Number(event.params.txId);

	const body = await readOptionalJson<{ psbt?: string }>(event);

	try {
		const { txid, transaction, duplicate, message } = await broadcastTransaction(
			user.id,
			walletId,
			txId,
			typeof body.psbt === 'string' ? body.psbt : undefined
		);
		return json({ txid, transaction, duplicate, message });
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
