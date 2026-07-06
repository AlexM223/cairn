import { json, requireUser } from '$lib/server/api';
import { getWallet } from '$lib/server/wallets';
import { getWalletUtxos } from '$lib/server/transactions';
import { classifyUtxoMasses } from '$lib/server/walletApi';
import { getCachedParentMass, rememberWalletMassProfile } from '$lib/server/bitcoin/signingMass';
import type { RequestHandler } from './$types';
import { childLogger } from '$lib/server/logger';

const log = childLogger('wallet');

/**
 * GET /api/wallets/:id/utxo-mass — signing-mass classification for each of
 * the wallet's current CONFIRMED UTXOs (parents of unconfirmed coins can
 * still change under RBF, and only confirmed coins are spendable anyway).
 *
 * Response: { masses: { txid, vout, parentVsize, tier, source }[] }
 *
 * Lazy + cached: parents are fetched only on this user-triggered request
 * (bounded concurrency and per-coin failure tolerance live in
 * classifyUtxoMasses, shared with the multisig twin).
 */
export const GET: RequestHandler = async (event) => {
	const user = requireUser(event);
	const id = Number(event.params.id);
	if (!Number.isInteger(id) || id <= 0) {
		return json({ error: 'Wallet not found' }, { status: 404 });
	}
	const wallet = getWallet(user.id, id);
	if (!wallet) return json({ error: 'Wallet not found' }, { status: 404 });

	try {
		const utxos = (await getWalletUtxos(wallet.xpub)).filter((u) => u.height > 0);
		const masses = await classifyUtxoMasses(utxos);

		// Remember this wallet's (value, parent-mass) profile so the multisig
		// wizard's signing-time preview can estimate from the user's real coins
		// without ever fetching (see /api/signing-time-preview). Deliberately NOT
		// done for multisigs — that cache is keyed by wallet id, and multisig ids
		// live in a different id space.
		rememberWalletMassProfile(
			user.id,
			wallet.id,
			utxos.flatMap((u) => {
				const parent = getCachedParentMass(u.txid);
				return parent ? [{ txid: u.txid, value: u.value, parentVsize: parent.vsize }] : [];
			})
		);

		return json({ masses });
	} catch (e) {
		log.error({ err: e, walletId: Number(event.params.id) }, 'wallet utxo-mass failed');
		return json(
			{ error: e instanceof Error ? e.message : 'Could not classify this wallet’s coins' },
			{ status: 502 }
		);
	}
};
