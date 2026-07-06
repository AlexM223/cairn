import { json } from '@sveltejs/kit';
import { requireFeature, readJson } from '$lib/server/api';
import { bumpTransaction, BumpError } from '$lib/server/transactions';
import { PsbtError } from '$lib/server/bitcoin/psbt';
import type { RequestHandler } from './$types';
import { childLogger } from '$lib/server/logger';

const log = childLogger('wallet');

/**
 * POST /api/wallets/:id/transactions/:txId/bump — build an RBF replacement
 * for a broadcast-but-unconfirmed transaction at a higher fee rate. Returns
 * the new draft's id; the send flow resumes it for signing and broadcast.
 */
export const POST: RequestHandler = async (event) => {
	// Gate fee bumping (RBF) behind the 'fee_bumping' feature flag.
	const user = requireFeature(event, 'fee_bumping');
	const walletId = Number(event.params.id);
	const txId = Number(event.params.txId);

	const body = await readJson<{ feeRate?: unknown }>(event);
	const feeRate = Number(body.feeRate);
	if (!Number.isFinite(feeRate) || feeRate <= 0) {
		return json({ error: 'A positive fee rate (sat/vB) is required.' }, { status: 400 });
	}

	try {
		const { draft } = await bumpTransaction(user.id, walletId, txId, feeRate);
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
		// Construction problems (insufficient change, fee ceiling, …) carry
		// user-presentable messages already.
		if (e instanceof PsbtError) {
			return json({ error: e.message, code: e.code }, { status: 400 });
		}
		log.error({ err: e, walletId, txId }, 'wallet fee-bump failed');
		return json(
			{ error: e instanceof Error ? e.message : 'Fee bump failed' },
			{ status: 500 }
		);
	}
};
