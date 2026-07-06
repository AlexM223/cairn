import { json } from '@sveltejs/kit';
import { requireFeature, readJson } from '$lib/server/api';
import { bumpMultisigTransaction } from '$lib/server/multisigTransactions';
import { BumpError } from '$lib/server/transactions';
import { PsbtError } from '$lib/server/bitcoin/psbt';
import type { RequestHandler } from './$types';
import { childLogger } from '$lib/server/logger';

const log = childLogger('wallet');

/**
 * POST /api/wallets/multisig/:id/transactions/:txId/bump — build an RBF
 * replacement for a broadcast-but-unconfirmed multisig transaction at a higher
 * fee rate. Returns the new draft's id; the send flow resumes it for the roster
 * to re-sign and the owner to broadcast. Owner-only (enforced in the service).
 */
export const POST: RequestHandler = async (event) => {
	// Gate fee bumping (RBF) behind the 'fee_bumping' feature flag, same as single-sig.
	const user = requireFeature(event, 'fee_bumping');
	const multisigId = Number(event.params.id);
	const txId = Number(event.params.txId);

	const body = await readJson<{ feeRate?: unknown }>(event);
	const feeRate = Number(body.feeRate);
	if (!Number.isFinite(feeRate) || feeRate <= 0) {
		return json({ error: 'A positive fee rate (sat/vB) is required.' }, { status: 400 });
	}

	try {
		const { draft } = await bumpMultisigTransaction(user.id, multisigId, txId, feeRate);
		return json({ id: draft.id, transaction: draft });
	} catch (e) {
		if (e instanceof BumpError) {
			const status =
				e.code === 'not_found'
					? 404
					: e.code === 'superseded' || e.code === 'already_replaced'
						? 409
						: 400;
			return json({ error: e.message, code: e.code }, { status });
		}
		if (e instanceof PsbtError) {
			return json({ error: e.message, code: e.code }, { status: 400 });
		}
		log.error({ err: e, multisigId, txId }, 'multisig fee-bump failed');
		return json({ error: e instanceof Error ? e.message : 'Fee bump failed' }, { status: 500 });
	}
};
