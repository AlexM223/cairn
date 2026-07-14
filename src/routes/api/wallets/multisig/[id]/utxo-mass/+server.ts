import { json, requireUser } from '$lib/server/api';
import { getViewableMultisig } from '$lib/server/wallets/multisig';
import { getMultisigUtxos } from '$lib/server/multisigScan';
import { classifyUtxoMasses } from '$lib/server/walletApi';
import type { RequestHandler } from './$types';
import { childLogger } from '$lib/server/logger';
import { sanitizeChainError } from '$lib/server/chainErrors';

const log = childLogger('wallet');

/**
 * GET /api/wallets/multisig/:id/utxo-mass — signing-mass classification for each of the
 * multisig's current CONFIRMED UTXOs. Response shape is identical to the wallet
 * variant: { masses: { txid, vout, parentVsize, tier, source }[] }.
 *
 * Lazy + cached + individually tolerant (see classifyUtxoMasses, shared with
 * the wallet twin): a coin whose parent can't be fetched or parsed is simply
 * absent from `masses` — the UI shows nothing for it rather than a guess.
 *
 * Unlike the wallet route this deliberately does NOT call
 * rememberWalletMassProfile: that cache is keyed by wallet id, and multisig ids
 * live in a different id space — feeding multisig coins in could collide with a
 * wallet's profile.
 */
export const GET: RequestHandler = async (event) => {
	const user = requireUser(event);
	const id = Number(event.params.id);
	if (!Number.isInteger(id) || id <= 0) {
		return json({ error: 'Multisig not found' }, { status: 404 });
	}
	// Read-only coin classification — owner or any accepted share.
	const multisig = getViewableMultisig(user.id, id);
	if (!multisig) return json({ error: 'Multisig not found' }, { status: 404 });

	try {
		const utxos = (await getMultisigUtxos(multisig)).filter((u) => u.height > 0);
		const masses = await classifyUtxoMasses(utxos);
		return json({ masses });
	} catch (e) {
		return json(
			{
				error: sanitizeChainError(
					e,
					log,
					{ multisigId: Number(event.params.id) },
					'wallet utxo-mass failed',
					undefined,
					'Could not classify this multisig’s coins'
				)
			},
			{ status: 502 }
		);
	}
};
