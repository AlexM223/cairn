// The gap-limit scan engine shared by single-sig (walletScan.ts) and multisig
// (multisigScan.ts) discovery. BIP44-style: derive addresses in batches, query
// Electrum for history + balance per scripthash, stop after GAP_LIMIT
// consecutive unused addresses (bounded by HARD_CAP), then attribute recent
// transactions to the wallet by scriptPubKey. The two wallet types differ ONLY
// in how an address is derived at (chain, index) — everything else here used
// to exist as two verbatim copies, constants included.

import { getChain } from '../chain/index';
import { addressToScripthash, scriptPubKeyHex } from './xpub';
import type { ElectrumBalance, ElectrumHistoryItem } from '../electrum/client';
import type { ElectrumLane } from '../electrum/pool';
import { Transaction } from '@scure/btc-signer';
import { hexToBytes, bytesToHex } from '@noble/hashes/utils.js';

export const GAP_LIMIT = 20;
const BATCH_SIZE = 20;
const HARD_CAP = 400; // per chain (receive / change)
const TX_DETAIL_CAP = 50;
const TX_FETCH_CONCURRENCY = 8;
export const SCAN_CACHE_TTL_MS = 60_000;

const RAW_TX_OPTS = {
	allowUnknownInputs: true,
	allowUnknownOutputs: true,
	disableScriptCheck: true
} as const;

/** What the engine learns about every derived address. Callers extend this
 *  with their own derivation metadata via the `deriveAt` type parameter. */
export interface GapScannedFields {
	address: string;
	index: number;
	used: boolean;
	/** Confirmed + unconfirmed sats currently on this address. */
	balance: number;
	txCount: number;
	history: ElectrumHistoryItem[];
	confirmedSats: number;
	unconfirmedSats: number;
}

/** One wallet-affecting transaction — structurally identical to both
 *  $lib/types' WalletTx and multisigScan's MultisigTx. */
export interface GapScanTx {
	txid: string;
	height: number; // 0 or -1 = unconfirmed
	time: number | null; // unix seconds, null if unconfirmed
	/** Net effect on the wallet in sats (positive = received). */
	delta: number;
	fee: number | null;
}

/**
 * Gap-limit discovery over one chain (receive or change). `deriveAt` supplies
 * the address at each index plus whatever derivation metadata the caller's
 * address shape carries (derivationPath/change for single-sig, chain for
 * multisig) — it is the ONLY wallet-type-specific step.
 */
export async function scanChainAddresses<TExtra extends { address: string }>(
	deriveAt: (index: number) => TExtra,
	lane: ElectrumLane = 'interactive'
): Promise<(TExtra & GapScannedFields)[]> {
	const chain = getChain();
	const out: (TExtra & GapScannedFields)[] = [];
	let consecutiveUnused = 0;
	let index = 0;

	while (consecutiveUnused < GAP_LIMIT && index < HARD_CAP) {
		const batch: (TExtra & { index: number })[] = [];
		for (let i = 0; i < BATCH_SIZE && index + i < HARD_CAP; i++) {
			batch.push({ ...deriveAt(index + i), index: index + i });
		}
		const scripthashes = batch.map((b) => addressToScripthash(b.address));

		const [histories, balances] = await Promise.all([
			chain.electrum.batchRequest(
				scripthashes.map((sh) => ({ method: 'blockchain.scripthash.get_history', params: [sh] })),
				lane
			) as Promise<ElectrumHistoryItem[][]>,
			chain.electrum.batchRequest(
				scripthashes.map((sh) => ({ method: 'blockchain.scripthash.get_balance', params: [sh] })),
				lane
			) as Promise<ElectrumBalance[]>
		]);

		for (let i = 0; i < batch.length; i++) {
			const history = histories[i] ?? [];
			const balance = balances[i] ?? { confirmed: 0, unconfirmed: 0 };
			const used = history.length > 0;
			consecutiveUnused = used ? 0 : consecutiveUnused + 1;
			out.push({
				...batch[i],
				used,
				balance: balance.confirmed + balance.unconfirmed,
				txCount: history.length,
				history,
				confirmedSats: balance.confirmed,
				unconfirmedSats: balance.unconfirmed
			});
			if (consecutiveUnused >= GAP_LIMIT) break;
		}
		index += batch.length;
	}

	// Trim the unused tail to exactly the gap window after the last used address.
	let lastUsed = -1;
	for (const a of out) if (a.used) lastUsed = Math.max(lastUsed, a.index);
	return out.filter((a) => a.index <= lastUsed + GAP_LIMIT);
}

/** Coinbase's synthetic prevout: 32 zero bytes at index 0xffffffff (consensus
 *  rule, not backend-specific — mirrors coinbaseScan.ts's isCoinbasePrevout). */
function isCoinbaseInput(input: { txid?: Uint8Array; index?: number }): boolean {
	return (
		input.index === 0xffffffff &&
		!!input.txid &&
		input.txid.length === 32 &&
		input.txid.every((b) => b === 0)
	);
}

/**
 * Wallet-relevant delta + fee for one transaction, derived ENTIRELY from raw
 * transaction bytes (chain.getTxHex — plain Electrum, no Core RPC needed). This is collectScanTxs()'s fallback for when chain.getTx() is
 * unavailable: in an Electrum-only deployment getTx() unconditionally throws
 * (no backend can serve decoded/verbose tx detail — see chain/index.ts), which
 * used to make EVERY wallet transaction silently vanish from the activity
 * feed (QA F4) — balance and per-address txCount stayed correct (both come
 * straight from Electrum history/balance calls) but the aggregated tx list,
 * and therefore wallet.lastActivity, stayed permanently empty.
 *
 * Outputs are read straight off the parsed tx (script + amount, no further
 * fetch). Each non-coinbase INPUT additionally needs its spent output's
 * script + amount, which only exists in the input's PARENT transaction, so
 * every distinct parent referenced by `txid`'s inputs is fetched too (same
 * getTxHex, deduped across the whole scan via `rawCache`, since a parent can
 * be shared by several of the wallet's own transactions — e.g. a change
 * output later spent). A parent that can't be fetched or parsed degrades that
 * one input out of the fee total (never guessed) and marks the fee
 * unresolvable (null); the tx itself is still reported (delta from whatever
 * DID resolve) rather than dropped, unlike the pre-fix behavior.
 */
async function txDeltaFromRaw(
	chain: ReturnType<typeof getChain>,
	txid: string,
	walletScripts: Set<string>,
	rawCache: Map<string, Uint8Array>
): Promise<{ delta: number; fee: number | null }> {
	async function rawBytes(id: string): Promise<Uint8Array> {
		const hit = rawCache.get(id);
		if (hit) return hit;
		const bytes = hexToBytes(await chain.getTxHex(id));
		rawCache.set(id, bytes);
		return bytes;
	}

	const tx = Transaction.fromRaw(await rawBytes(txid), RAW_TX_OPTS);

	let delta = 0;
	let totalOut = 0;
	for (let i = 0; i < tx.outputsLength; i++) {
		const out = tx.getOutput(i);
		const amount = Number(out.amount ?? 0n);
		totalOut += amount;
		if (out.script && walletScripts.has(bytesToHex(out.script).toLowerCase())) {
			delta += amount;
		}
	}

	let totalIn = 0;
	let feeResolvable = true;
	for (let i = 0; i < tx.inputsLength; i++) {
		const input = tx.getInput(i);
		if (isCoinbaseInput(input)) continue;
		if (!input.txid || input.index === undefined) {
			feeResolvable = false;
			continue;
		}
		try {
			const parent = Transaction.fromRaw(await rawBytes(bytesToHex(input.txid)), RAW_TX_OPTS);
			const spent = parent.getOutput(input.index);
			if (!spent) {
				feeResolvable = false;
				continue;
			}
			const value = Number(spent.amount ?? 0n);
			totalIn += value;
			if (spent.script && walletScripts.has(bytesToHex(spent.script).toLowerCase())) {
				delta -= value;
			}
		} catch {
			// Parent unfetchable/unparseable — skip its contribution (never guess)
			// rather than fail the whole tx.
			feeResolvable = false;
		}
	}

	return { delta, fee: feeResolvable ? totalIn - totalOut : null };
}

/**
 * Attribute recent transactions to the wallet from the scanned addresses'
 * merged histories. Matching is by scriptPubKey, NOT by address string: the
 * script is network-independent, so this is correct even when the explorer
 * reports a different network's address encoding (e.g. regtest bcrt1…) than
 * Cairn's mainnet-only derivation (bc1…) — an address-string match would miss
 * every output and report delta 0. See scriptPubKeyHex in xpub.ts.
 *
 * Newest TX_DETAIL_CAP transactions only, fetched with bounded concurrency.
 * chain.getTx() (Core RPC) is tried first; when it's unavailable —
 * always the case in an Electrum-only deployment — txDeltaFromRaw() derives
 * the same delta/fee purely from Electrum raw-tx data instead of dropping the
 * transaction (QA F4). Only a genuine failure of BOTH paths omits a tx.
 */
export async function collectScanTxs(
	scanned: { address: string; history: ElectrumHistoryItem[] }[]
): Promise<GapScanTx[]> {
	const chain = getChain();
	const walletScripts = new Set<string>();
	for (const a of scanned) {
		try {
			walletScripts.add(scriptPubKeyHex(a.address).toLowerCase());
		} catch {
			/* skip an address we can't decode (shouldn't happen for derived ones) */
		}
	}

	// Merge + dedupe histories; prefer a confirmed height over a mempool one.
	const heights = new Map<string, number>();
	for (const a of scanned) {
		for (const h of a.history) {
			const prev = heights.get(h.tx_hash);
			if (prev === undefined || (prev <= 0 && h.height > 0)) {
				heights.set(h.tx_hash, h.height);
			}
		}
	}

	// Newest first: unconfirmed (height <= 0) first, then by height descending.
	const ordered = [...heights.entries()].sort((a, b) => {
		const ha = a[1] <= 0 ? Number.MAX_SAFE_INTEGER : a[1];
		const hb = b[1] <= 0 ? Number.MAX_SAFE_INTEGER : b[1];
		return hb - ha;
	});
	const recent = ordered.slice(0, TX_DETAIL_CAP);

	const rawCache = new Map<string, Uint8Array>();
	const blockTimeCache = new Map<number, number | null>();
	async function blockTimeAt(height: number): Promise<number | null> {
		if (height <= 0) return null;
		const hit = blockTimeCache.get(height);
		if (hit !== undefined) return hit;
		const t = await chain.getBlockTimeAtHeight(height).catch(() => null);
		blockTimeCache.set(height, t);
		return t;
	}

	const txs: GapScanTx[] = [];
	for (let i = 0; i < recent.length; i += TX_FETCH_CONCURRENCY) {
		const chunk = recent.slice(i, i + TX_FETCH_CONCURRENCY);
		const results = await Promise.all(
			chunk.map(async ([txid, height]): Promise<GapScanTx | null> => {
				try {
					const tx = await chain.getTx(txid);
					let delta = 0;
					for (const out of tx.vout) {
						if (out.scriptPubKey && walletScripts.has(out.scriptPubKey.toLowerCase())) {
							delta += out.value;
						}
					}
					for (const vin of tx.vin) {
						if (
							!vin.coinbase &&
							vin.prevScriptPubKey &&
							walletScripts.has(vin.prevScriptPubKey.toLowerCase())
						) {
							delta -= vin.value ?? 0;
						}
					}
					return { txid, height, time: tx.blockTime, delta, fee: tx.fee };
				} catch {
					// getTx() needs Core RPC — always throws in an
					// Electrum-only deployment (QA F4). Fall back to deriving the
					// same delta/fee straight from Electrum raw-tx data before
					// giving up on this transaction.
					try {
						const { delta, fee } = await txDeltaFromRaw(chain, txid, walletScripts, rawCache);
						return { txid, height, time: await blockTimeAt(height), delta, fee };
					} catch {
						// Genuinely unfetchable/unparseable — omit rather than guess.
						return null;
					}
				}
			})
		);
		for (const r of results) if (r) txs.push(r);
	}
	return txs;
}

/**
 * The full two-chain scan both wallet types run: receive + change discovery in
 * parallel, transaction attribution, and balance totals. Returns both the raw
 * `scanned` entries (with per-address histories, for callers that need them)
 * and the public `addresses` shape with the heavy scan-internal fields
 * stripped.
 */
export async function runGapScan<TExtra extends { address: string }>(
	deriveAt: (chain: 0 | 1, index: number) => TExtra,
	lane: ElectrumLane = 'interactive'
): Promise<{
	scanned: (TExtra & GapScannedFields)[];
	addresses: (TExtra & Omit<GapScannedFields, 'history' | 'confirmedSats' | 'unconfirmedSats'>)[];
	txs: GapScanTx[];
	confirmed: number;
	unconfirmed: number;
}> {
	const [receive, change] = await Promise.all([
		scanChainAddresses((i) => deriveAt(0, i), lane),
		scanChainAddresses((i) => deriveAt(1, i), lane)
	]);
	const scanned = [...receive, ...change];

	const txs = await collectScanTxs(scanned);

	let confirmed = 0;
	let unconfirmed = 0;
	for (const a of scanned) {
		confirmed += a.confirmedSats;
		unconfirmed += a.unconfirmedSats;
	}

	// The rest-spread provably keeps every TExtra key (only GapScannedFields'
	// scan-internal fields are pulled off), but TypeScript cannot see through
	// Omit over an open generic — hence the assertion.
	const addresses = scanned.map(
		({ history: _h, confirmedSats: _c, unconfirmedSats: _u, ...addr }) => addr
	) as (TExtra & Omit<GapScannedFields, 'history' | 'confirmedSats' | 'unconfirmedSats'>)[];
	return { scanned, addresses, txs, confirmed, unconfirmed };
}

/**
 * The in-process scan cache both wallet types keep: TTL'd promises keyed by
 * xpub / descriptor, failures never cached (and never left as unhandled
 * rejections), with startup priming that only fills an empty or expired slot —
 * never clobbering a fresher live scan already in flight.
 */
export class ScanCache<T> {
	private cache = new Map<string, { expires: number; promise: Promise<T> }>();

	constructor(private readonly ttlMs: number = SCAN_CACHE_TTL_MS) {}

	/**
	 * Return the cached scan for `key` when fresh, otherwise start `scan()` and
	 * cache it. `forceRefresh` skips the cache-hit read (but still writes) — the
	 * startup warm pass uses it so the persisted seed it just loaded gets
	 * replaced with a live scan rather than being served back to itself.
	 */
	fetch(key: string, scan: () => Promise<T>, opts: { forceRefresh?: boolean } = {}): Promise<T> {
		const now = Date.now();
		if (!opts.forceRefresh) {
			const hit = this.cache.get(key);
			if (hit && hit.expires > now) return hit.promise;
		}

		const promise = scan();
		this.cache.set(key, { expires: now + this.ttlMs, promise });
		promise.catch(() => {
			// Never cache failures (and never leave an unhandled rejection).
			if (this.cache.get(key)?.promise === promise) this.cache.delete(key);
		});
		return promise;
	}

	/** Seed only an empty/expired slot (startup prime) with a normal TTL, so
	 *  early requests are served until the warm pass force-refreshes. */
	prime(key: string, result: T): void {
		const now = Date.now();
		const hit = this.cache.get(key);
		if (hit && hit.expires > now) return;
		this.cache.set(key, { expires: now + this.ttlMs, promise: Promise.resolve(result) });
	}

	delete(key: string): void {
		this.cache.delete(key);
	}

	clear(): void {
		this.cache.clear();
	}
}
