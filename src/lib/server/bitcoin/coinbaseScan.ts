// Coinbase (mining reward) detection for wallet UTXOs. A coinbase tx has
// exactly one input whose prevout is synthetic: txid = 32 zero bytes, index =
// 0xffffffff (consensus-enforced, not backend-specific). We derive that
// directly from the funding tx's RAW SERIALIZATION (getTxHex) rather than a
// decoded/verbose tx lookup (getTx) — getTxHex is served by a plain Electrum
// connection (`blockchain.transaction.get`) with no Core RPC backend
// required, so this works in every backend configuration (fund-freeze fix:
// getTx unconditionally throws in Electrum-only mode, which used to make
// every UTXO resolve to 'unknown').
//
// A txid's coinbase-ness is IMMUTABLE, so we cache it process-wide and never
// expire it: a miner with many block rewards pays the funding-tx fetch once per
// reward, then every subsequent scan is free.

import { getChain } from '../chain';
import { childLogger } from '../logger';
import { Transaction } from '@scure/btc-signer';
import { hexToBytes } from '@noble/hashes/utils.js';
import type { CoinbaseStatus, SpendableUtxo } from './psbt';

const log = childLogger('coinbase');

// Only definitive (true/false) results are cached — coinbase-ness is immutable.
// 'unknown' comes from a transient fetch/parse failure and must never be cached.
const coinbaseCache = new Map<string, boolean>();

/** Coinbase's synthetic prevout: 32 zero bytes at index 0xffffffff. */
function isCoinbasePrevout(input: { txid?: Uint8Array; index?: number }): boolean {
	return (
		input.index === 0xffffffff &&
		!!input.txid &&
		input.txid.length === 32 &&
		input.txid.every((b) => b === 0)
	);
}

/**
 * Whether transaction `txid` is a coinbase (mining reward) transaction. Returns
 * 'unknown' when the funding tx's raw bytes can't be fetched or parsed —
 * callers MUST treat that as "unverifiable", not as a safe "not coinbase", so a
 * transient chain hiccup can't make an immature mining reward look ordinary and
 * spendable (cairn-7fmd). With getTxHex backing this (works on Electrum alone,
 * no Core RPC needed), 'unknown' is now reserved for genuine
 * transient failures, not a permanent per-backend capability gap.
 */
async function isCoinbaseTx(txid: string): Promise<CoinbaseStatus> {
	const cached = coinbaseCache.get(txid);
	if (cached !== undefined) return cached;
	try {
		const hex = await getChain().getTxHex(txid);
		const tx = Transaction.fromRaw(hexToBytes(hex), {
			allowUnknownInputs: true,
			allowUnknownOutputs: true,
			disableScriptCheck: true
		});
		// Consensus rule: a coinbase tx has EXACTLY one input, and that input's
		// prevout is the synthetic all-zero/0xffffffff marker.
		const coinbase = tx.inputsLength === 1 && isCoinbasePrevout(tx.getInput(0));
		coinbaseCache.set(txid, coinbase);
		return coinbase;
	} catch (err) {
		// Chain hiccup (fetch failed) or bad/unparseable data — report 'unknown'
		// (NOT a silent "safe to spend" false) and don't cache, so a later scan
		// can determine it correctly.
		log.warn({ err, txid }, 'coinbase check failed — funding tx unfetchable, status unknown');
		return 'unknown';
	}
}

/**
 * Annotate each UTXO with whether its funding transaction is a coinbase. Distinct
 * funding txs are fetched in parallel and cached (coinbase-ness never changes).
 * Best-effort: a fetch failure leaves `coinbase = 'unknown'` (treated
 * conservatively by the maturity guard) rather than failing the whole scan.
 * Mutates and returns the same array.
 */
export async function annotateCoinbase(utxos: SpendableUtxo[]): Promise<SpendableUtxo[]> {
	const distinct = [...new Set(utxos.map((u) => u.txid))];
	const statuses = new Map<string, CoinbaseStatus>();
	await Promise.all(
		distinct.map(async (txid) => {
			statuses.set(txid, await isCoinbaseTx(txid));
		})
	);
	for (const u of utxos) u.coinbase = statuses.get(u.txid) ?? false;
	return utxos;
}
