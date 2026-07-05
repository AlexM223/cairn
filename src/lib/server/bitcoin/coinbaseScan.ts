// Coinbase (mining reward) detection for wallet UTXOs. Electrum's listUnspent
// doesn't say whether an output came from a coinbase transaction, so we fetch the
// funding tx and check its inputs (a coinbase tx has a single synthetic input
// with no real prevout — chain layer flags it as vin[].coinbase).
//
// A txid's coinbase-ness is IMMUTABLE, so we cache it process-wide and never
// expire it: a miner with many block rewards pays the funding-tx fetch once per
// reward, then every subsequent scan is free.

import { getChain } from '../chain';
import type { SpendableUtxo } from './psbt';

const coinbaseCache = new Map<string, boolean>();

/** Whether transaction `txid` is a coinbase (mining reward) transaction. */
async function isCoinbaseTx(txid: string): Promise<boolean> {
	const cached = coinbaseCache.get(txid);
	if (cached !== undefined) return cached;
	try {
		const tx = await getChain().getTx(txid);
		const coinbase = tx.vin.some((v) => v.coinbase);
		coinbaseCache.set(txid, coinbase);
		return coinbase;
	} catch {
		// Chain hiccup — treat as non-coinbase for now, and DON'T cache the failure
		// so a later scan can determine it correctly.
		return false;
	}
}

/**
 * Annotate each UTXO with whether its funding transaction is a coinbase. Distinct
 * funding txs are fetched in parallel and cached (coinbase-ness never changes).
 * Best-effort: a fetch failure leaves `coinbase = false` rather than failing the
 * whole scan. Mutates and returns the same array.
 */
export async function annotateCoinbase(utxos: SpendableUtxo[]): Promise<SpendableUtxo[]> {
	const distinct = [...new Set(utxos.map((u) => u.txid))];
	const statuses = new Map<string, boolean>();
	await Promise.all(
		distinct.map(async (txid) => {
			statuses.set(txid, await isCoinbaseTx(txid));
		})
	);
	for (const u of utxos) u.coinbase = statuses.get(u.txid) ?? false;
	return utxos;
}
