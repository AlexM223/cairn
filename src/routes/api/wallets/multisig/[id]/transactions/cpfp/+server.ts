import { json } from '@sveltejs/kit';
import { requireFeature, readJson } from '$lib/server/api';
import { buildMultisigCpfpDraft } from '$lib/server/multisigTransactions';
import { CpfpError } from '$lib/server/transactions';
import { PsbtError } from '$lib/server/bitcoin/psbt';
import type { RequestHandler } from './$types';
import { childLogger } from '$lib/server/logger';

const log = childLogger('multisig');

/**
 * POST /api/wallets/multisig/:id/transactions/cpfp — build a child-pays-for-parent
 * (CPFP) draft for a vault: spend the vault's own unconfirmed output on a stuck
 * parent at a high fee so the package averages the target rate. A new draft (no
 * replaces_txid) that re-enters the roster sign/broadcast flow. Body:
 * { parentTxid, feeRate }.
 */
export const POST: RequestHandler = async (event) => {
	const user = requireFeature(event, 'fee_bumping');
	const multisigId = Number(event.params.id);

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
		const { draft, cpfp, chainDepthWarning } = await buildMultisigCpfpDraft(
			user.id,
			multisigId,
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
		log.error({ err: e, multisigId, parentTxid }, 'multisig CPFP build failed');
		return json({ error: e instanceof Error ? e.message : 'CPFP build failed' }, { status: 500 });
	}
};
