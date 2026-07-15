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
import { childLogger } from '../logger';

const log = childLogger('gap-scan');

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

/** Result of one chain's gap-limit discovery: the scanned addresses plus
 *  whether HARD_CAP cut the scan short before a full gap-limit-wide quiet
 *  window confirmed the wallet was actually done. */
export interface ChainScanResult<T> {
	addresses: T[];
	/** True when HARD_CAP stopped discovery while the trailing gap-limit
	 *  window still had activity in it — i.e. the scan would have kept going
	 *  had the cap not been there, so there may be used addresses (and funds)
	 *  past the cap that this scan never got to see. False on a normal
	 *  gap-limit-satisfied completion, even one that happens to land exactly
	 *  on the cap boundary (nothing was left unexamined in that case). */
	truncated: boolean;
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
): Promise<ChainScanResult<TExtra & GapScannedFields>> {
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

	// HARD_CAP stopped us before a full gap-limit-wide quiet window confirmed
	// the wallet was done: consecutiveUnused < GAP_LIMIT here means a used
	// address is still within the trailing gap window, so this chain could
	// have kept going — anything past the cap is invisible, silently, unless
	// we flag it (cairn-kxhv). A completion that lands exactly on the cap
	// boundary WITH a full quiet gap already satisfied (consecutiveUnused >=
	// GAP_LIMIT) is a normal, non-truncated finish that merely coincides with
	// the cap — nothing was left unexamined.
	const truncated = index >= HARD_CAP && consecutiveUnused < GAP_LIMIT;
	if (truncated) {
		log.warn(
			{ lane, lastIndexScanned: index - 1, consecutiveUnused, hardCap: HARD_CAP, gapLimit: GAP_LIMIT },
			'gap-limit scan hit HARD_CAP with activity still in the gap window — addresses (and possibly funds) past the cap were not scanned'
		);
	}

	// Trim the unused tail to exactly the gap window after the last used address.
	let lastUsed = -1;
	for (const a of out) if (a.used) lastUsed = Math.max(lastUsed, a.index);
	return { addresses: out.filter((a) => a.index <= lastUsed + GAP_LIMIT), truncated };
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
 * transaction bytes (chain.getTxHex — plain Electrum, no Core RPC needed).
 * This is collectScanTxs()'s fallback for when chain.getTx() is unavailable
 * (no Core RPC configured) or its decode carries no prevout data — a
 * full-indexing Electrum server's verbose transaction.get (electrs does not
 * even support verbose=true; Fulcrum/ElectrumX do but still omit prevout) or
 * an old pre-verbosity-2 Core node both decode a tx without any prevout, and
 * used to make every such wallet transaction either vanish from the activity
 * feed entirely (an outright getTx() throw, QA F4) or — worse — render with a
 * silently wrong delta (a "successful" decode that never subtracted spent
 * wallet inputs, cairn-uhg1). Balance and per-address txCount are never
 * affected by either failure mode (both come straight from Electrum
 * history/balance calls); only the aggregated tx list and wallet.lastActivity
 * were at risk.
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
 * chain.getTx() is tried first (full Core prevout data when Core RPC is
 * configured); when it's unavailable, or it decoded without prevout data (no
 * Core configured, or an old Core/full-indexing-Electrum decode that carries
 * no prevout — cairn-zc4x, cairn-uhg1), txDeltaFromRaw() derives the same
 * delta/fee purely from raw tx bytes instead of dropping the transaction (QA
 * F4) or silently under-counting it. Only a genuine failure of BOTH paths
 * omits a tx.
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
					// getTx() decodes via Bitcoin Core (verbosity 2, full prevout on
					// every input) when Core RPC is configured, but degrades to an
					// Electrum-only fallback otherwise (chain/index.ts's
					// getTxViaElectrum, cairn-zc4x) — and a full-indexing Electrum
					// server's verbose decode carries NO prevout at all, same as an
					// old pre-verbosity-2 Core node. Either way every non-coinbase
					// vin's prevScriptPubKey/value comes back null, which would
					// silently under-count this tx's delta (spent wallet inputs never
					// subtracted) instead of computing a wrong-but-plausible-looking
					// balance change. Treat that shape as untrustworthy for the scan's
					// purposes and fall through to the raw-parse path below, which
					// resolves prevouts itself from each input's parent tx
					// (cairn-uhg1) instead of silently misreporting.
					const hasUnresolvedPrevout = tx.vin.some(
						(vin) => !vin.coinbase && vin.prevScriptPubKey === null && vin.value === null
					);
					if (hasUnresolvedPrevout) throw new Error('getTx() result has no prevout data');
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
					// No Core RPC, or Core/Electrum decoded the tx without prevout
					// data (QA F4 and cairn-uhg1). Fall back to deriving the same
					// delta/fee straight from raw tx bytes instead of giving up on
					// this transaction (or trusting an incomplete decode).
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
	/** True when either chain's HARD_CAP truncated discovery with activity
	 *  still in its gap window (see ChainScanResult.truncated) — surfaced so
	 *  callers can flag the wallet as possibly showing an incomplete balance
	 *  instead of silently under-reporting it (cairn-kxhv). */
	scanTruncated: boolean;
}> {
	const [receive, change] = await Promise.all([
		scanChainAddresses((i) => deriveAt(0, i), lane),
		scanChainAddresses((i) => deriveAt(1, i), lane)
	]);
	const scanned = [...receive.addresses, ...change.addresses];
	const scanTruncated = receive.truncated || change.truncated;

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
	return { scanned, addresses, txs, confirmed, unconfirmed, scanTruncated };
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
