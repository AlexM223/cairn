import { json, requireUser } from '$lib/server/api';
import { getWallet } from '$lib/server/wallets';
import { getWalletUtxos } from '$lib/server/transactions';
import { getChain } from '$lib/server/chain';
import {
	classifyAndCacheParent,
	getCachedParentMass,
	rememberWalletMassProfile,
	tierForVsize
} from '$lib/server/bitcoin/signingMass';
import type { RequestHandler } from './$types';
import { childLogger } from '$lib/server/logger';

const log = childLogger('wallet');

/**
 * How many parent transactions to fetch from the chain source at once. The
 * endpoint is user-triggered (the coin-control mass disclosure), so it IS
 * allowed to fetch — but a wallet of pool payouts could reference dozens of
 * multi-hundred-KB parents, so fetches are bounded rather than fired all at
 * once, and everything lands in the process-wide parent cache so the work
 * happens once per parent per process.
 */
const FETCH_CONCURRENCY = 4;

/**
 * GET /api/wallets/:id/utxo-mass — signing-mass classification for each of
 * the wallet's current CONFIRMED UTXOs (parents of unconfirmed coins can
 * still change under RBF, and only confirmed coins are spendable anyway).
 *
 * Response: { masses: { txid, vout, parentVsize, tier, source }[] }
 *
 * Lazy + cached: parents are fetched only on this user-triggered request,
 * consulted from the in-process cache first, and individually tolerated on
 * failure — a coin whose parent can't be fetched or parsed is simply absent
 * from `masses` (the UI shows nothing for it rather than a guess).
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

		// Remember this wallet's (value, parent-mass) profile so the multisig
		// wizard's signing-time preview can estimate from the user's real coins
		// without ever fetching (see /api/signing-time-preview).
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
