import { json, requireUser } from '$lib/server/api';
import { getVault } from '$lib/server/vaults';
import { getVaultUtxos } from '$lib/server/vaultScan';
import { getChain } from '$lib/server/chain';
import {
	classifyAndCacheParent,
	getCachedParentMass,
	tierForVsize
} from '$lib/server/bitcoin/signingMass';
import type { RequestHandler } from './$types';

/**
 * How many parent transactions to fetch from the chain source at once — same
 * bound (and the same reasoning) as the wallet-scoped twin at
 * /api/wallets/[id]/utxo-mass: user-triggered, so fetching is allowed, but a
 * vault holding pool payouts could reference dozens of multi-hundred-KB
 * parents, so fetches are bounded and land in the process-wide parent cache.
 */
const FETCH_CONCURRENCY = 4;

/**
 * GET /api/vaults/:id/utxo-mass — signing-mass classification for each of the
 * vault's current CONFIRMED UTXOs. Response shape is identical to the wallet
 * variant: { masses: { txid, vout, parentVsize, tier, source }[] }.
 *
 * Lazy + cached + individually tolerant: a coin whose parent can't be fetched
 * or parsed is simply absent from `masses` — the UI shows nothing for it
 * rather than a guess.
 *
 * Unlike the wallet route this deliberately does NOT call
 * rememberWalletMassProfile: that cache is keyed by wallet id, and vault ids
 * live in a different id space — feeding vault coins in could collide with a
 * wallet's profile.
 */
export const GET: RequestHandler = async (event) => {
	const user = requireUser(event);
	const id = Number(event.params.id);
	if (!Number.isInteger(id) || id <= 0) {
		return json({ error: 'Vault not found' }, { status: 404 });
	}
	const vault = getVault(user.id, id);
	if (!vault) return json({ error: 'Vault not found' }, { status: 404 });

	try {
		const utxos = (await getVaultUtxos(vault)).filter((u) => u.height > 0);

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
		return json(
			{ error: e instanceof Error ? e.message : 'Could not classify this vault’s coins' },
			{ status: 502 }
		);
	}
};
