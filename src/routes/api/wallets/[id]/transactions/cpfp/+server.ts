import { json } from '@sveltejs/kit';
import { requireFeature, readJson } from '$lib/server/api';
import { buildCpfpDraft, CpfpError } from '$lib/server/transactions';
import { PsbtError } from '$lib/server/bitcoin/psbt';
import type { RequestHandler } from './$types';
import { childLogger } from '$lib/server/logger';

const log = childLogger('wallet');

/**
 * POST /api/wallets/:id/transactions/cpfp — build a child-pays-for-parent (CPFP)
 * draft that accelerates a stuck, still-unconfirmed parent by spending this
 * wallet's own unconfirmed output on it at a high fee. Unlike RBF this is a
 * genuinely new draft (no replaces_txid); the send flow resumes it for signing
 * and broadcast. Body: { parentTxid, feeRate }.
 */
export const POST: RequestHandler = async (event) => {
	// CPFP is a fee-acceleration path — gate it behind the same flag as RBF.
	const user = requireFeature(event, 'fee_bumping');
	const walletId = Number(event.params.id);

	const body = await readJson<{ parentTxid?: unknown; feeRate?: unknown }>(event);
	const parentTxid = typeof body.parentTxid === 'string' ? body.parentTxid.trim() : '';
	if (!/^[0-9a-fA-F]{64}$/.test(parentTxid)) {
		return json({ error: 'A valid parent transaction id is required.' }, { status: 400 });
	}
	const feeRate = Number(body.feeRate);
	if (!Number.isFinite(feeRate) || feeRate <= 0) {
		return json({ error: 'A positive target fee rate (sat/vB) is required.' }, { status: 400 });
	}

	try {
		const { draft, cpfp, chainDepthWarning } = await buildCpfpDraft(
			user.id,
			walletId,
			parentTxid,
			feeRate
		);
		return json({ id: draft.id, transaction: draft, cpfp, chainDepthWarning });
	} catch (e) {
		if (e instanceof CpfpError) {
			const status = e.code === 'not_found' ? 404 : e.code === 'already_confirmed' ? 409 : 400;
			return json({ error: e.message, code: e.code }, { status });
		}
		if (e instanceof PsbtError) {
			return json({ error: e.message, code: e.code }, { status: 400 });
		}
		log.error({ err: e, walletId, parentTxid }, 'wallet CPFP build failed');
		return json({ error: e instanceof Error ? e.message : 'CPFP build failed' }, { status: 500 });
	}
};
