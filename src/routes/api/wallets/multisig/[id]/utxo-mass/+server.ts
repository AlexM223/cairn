import { json, requireUser } from '$lib/server/api';
import { getViewableMultisig } from '$lib/server/wallets/multisig';
import { getMultisigUtxos } from '$lib/server/multisigScan';
import { getChain } from '$lib/server/chain';
import {
	classifyAndCacheParent,
	getCachedParentMass,
	tierForVsize
} from '$lib/server/bitcoin/signingMass';
import type { RequestHandler } from './$types';
import { childLogger } from '$lib/server/logger';

const log = childLogger('wallet');

/**
 * How many parent transactions to fetch from the chain source at once — same
 * bound (and the same reasoning) as the wallet-scoped twin at
 * /api/wallets/[id]/utxo-mass: user-triggered, so fetching is allowed, but a
 * multisig holding pool payouts could reference dozens of multi-hundred-KB
 * parents, so fetches are bounded and land in the process-wide parent cache.
 */
const FETCH_CONCURRENCY = 4;

/**
 * GET /api/wallets/multisig/:id/utxo-mass — signing-mass classification for each of the
 * multisig's current CONFIRMED UTXOs. Response shape is identical to the wallet
 * variant: { masses: { txid, vout, parentVsize, tier, source }[] }.
 *
 * Lazy + cached + individually tolerant: a coin whose parent can't be fetched
 * or parsed is simply absent from `masses` — the UI shows nothing for it
 * rather than a guess.
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

		// Unique parents not yet cached, fetched with bounded concurrency.
		const missing = [...new Set(utxos.map((u) => u.txid))].filter(
			(txid) => !getCachedParentMass(txid)
		);
		const chain = getChain();
		let next = 0;
		const workers = Array.from({ length: Math.min(FETCH_CONCURRENCY, missing.length) }, async () => {
			while (next < missing.length) {
				const txid = missing[next++];
				try {
					classifyAndCacheParent(txid, await chain.getTxHex(txid));
				} catch {
					// Tolerated: this parent's coins are left out of the response.
				}
			}
		});
		await Promise.all(workers);

		const masses = utxos.flatMap((u) => {
			const parent = getCachedParentMass(u.txid);
			if (!parent) return [];
			return [
				{
					txid: u.txid,
					vout: u.vout,
					parentVsize: parent.vsize,
					tier: tierForVsize(parent.vsize),
					source: parent.source
				}
			];
		});

		return json({ masses });
	} catch (e) {
		log.error({ err: e, multisigId: Number(event.params.id) }, 'wallet utxo-mass failed');
		return json(
			{ error: e instanceof Error ? e.message : 'Could not classify this multisig’s coins' },
			{ status: 502 }
		);
	}
};
