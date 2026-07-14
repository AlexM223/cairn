// ChainService: the facade routes and features import for all chain data.
// Tip, recent blocks, fee estimates, difficulty/hashrate, arbitrary address
// lookups, node liveness and wallet balances+history all come from the operator's
// own Electrum protocol server. The explorer-rich views (full block/tx detail,
// mempool summary/projections, CPFP) come from the operator's own Bitcoin Core
// node over JSON-RPC (cairn-zoz8.10/.11/.12/.14). There is no third-party HTTP
// explorer API anywhere in the path (cairn-zoz8.16): an
// Umbrel-style deploy (local Core RPC + electrs, no route to the public internet)
// is fully functional, and a Core-backed method degrades to a clear "needs Core
// RPC" error rather than silently dialing an external host.

import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { getChainConfig } from '../settings';
import { ElectrumClient } from '../electrum/client';
import { ElectrumPool } from '../electrum/pool';
import type { ElectrumBalance, ElectrumHistoryItem } from '../electrum/client';
import { addressToScripthash, scriptPubKeyHex } from '../bitcoin/xpub';
import { wireChainEvents, resetConnectionState } from '../chainEvents';
import { noteProxyConfigured, resetChainHealth, resetCoreHealth, recordCoreOk, recordCoreError } from '../chainHealth';
import { resetPackageRelaySupport } from '../packageRelay';
import { recordActivity } from '../activity';
import { childLogger } from '../logger';
import { CoreRpcClient, CoreRpcError } from '../bitcoinCore/client';
import { readMempoolTrend } from '../mempoolSamples';
import {
	cachedTip,
	cachedFeeEstimates,
	cachedMempoolSummary,
	cachedFeeHistogram,
	resetChainCaches,
	getCachedRawTx,
	cacheRawTx,
	getCachedBlockStats,
	cacheBlockStats,
	getCachedPool,
	cachePool,
	getCachedHeader,
	cacheHeader,
	getCachedMerklePos,
	cacheMerklePos
} from './cache';
import { identifyPool } from './pools';
import type {
	AddressInfo,
	AddressTx,
	BlockContext,
	BlockContextNeighbor,
	BlockDetail,
	BlockPool,
	BlockSummary,
	CpfpInfo,
	DifficultyAdjustment,
	DifficultyInfo,
	FeeEstimates,
	FeeHistogram,
	MempoolBlockProjection,
	MempoolSummary,
	MempoolTrendPoint,
	NodeInfo,
	RbfInfo,
	TxDetail,
	TxVin,
	TxVout
} from '$lib/types';

const BLOCK_TXS_PAGE_SIZE = 25;

const log = childLogger('chain');

// Public BTC/USD price source for the opt-in fiat estimate. This is the ONE
// remaining external call in the chain layer (cairn-zoz8.18): neither Electrum
// nor Bitcoin Core RPC exposes a spot price, so an operator who wants a fiat
// figure reaches this public endpoint. Cached process-wide (independent of the
// configured backend, so it survives a chain reconfigure) with a short timeout
// so it can never gate a page render, and it only fires when a caller actually
// asks for a fiat value.
const PUBLIC_PRICE_URL = 'https://mempool.space/api/v1/prices';
const PUBLIC_PRICE_TTL_MS = 5 * 60_000;
let publicPriceCache: { at: number; usd: number | null } | null = null;

async function fetchPublicBtcUsdPrice(): Promise<number | null> {
	const now = Date.now();
	if (publicPriceCache && now - publicPriceCache.at < PUBLIC_PRICE_TTL_MS) {
		return publicPriceCache.usd;
	}
	let usd: number | null = null;
	try {
		const res = await fetch(PUBLIC_PRICE_URL, { signal: AbortSignal.timeout(6000) });
		if (res.ok) {
			const body = (await res.json()) as { USD?: number };
			if (typeof body.USD === 'number' && body.USD > 0) usd = body.USD;
		}
	} catch (e) {
		log.debug({ err: e }, 'public BTC/USD price fetch failed');
		usd = null;
	}
	publicPriceCache = { at: now, usd };
	return usd;
}

// --------------------------------------------------------------------- helpers

/** Block hash = double-sha256 of the 80-byte header, displayed byte-reversed. */
function blockHashFromHeader(headerHex: string): string {
	const hash = sha256(sha256(hexToBytes(headerHex)));
	hash.reverse();
	return bytesToHex(hash);
}

/**
 * Difficulty implied by a header's compact `nBits` target, relative to the
 * genesis difficulty-1 target (0x1d00ffff). Standard Bitcoin Core GetDifficulty:
 * `difficulty = (0xffff / mantissa) * 2^(8 * (0x1d - exponent))`, where the bits
 * word splits into an 8-bit exponent (high byte) and a 23-bit mantissa.
 */
function bitsToDifficulty(bits: number): number {
	const exponent = bits >>> 24;
	const mantissa = bits & 0x007fffff;
	if (mantissa === 0) return 0;
	return (0xffff / mantissa) * Math.pow(2, 8 * (0x1d - exponent));
}

/**
 * Decode the fields carried by Electrum's raw 80-byte block header
 * (`blockchain.block.header`). A bare header does NOT include tx_count/size/weight
 * or fee stats — those need a full block or an index the Electrum protocol doesn't
 * expose — so any BlockSummary built from this alone leaves those 0/null until a
 * later Bitcoin Core RPC bead (cairn-zoz8.10) enriches it.
 */
function decodeBlockHeader(headerHex: string): {
	version: number;
	prevHash: string;
	merkleRoot: string;
	time: number;
	bits: number;
	nonce: number;
	difficulty: number;
	hash: string;
} {
	const bytes = hexToBytes(headerHex);
	const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const bits = dv.getUint32(72, true);
	return {
		version: dv.getInt32(0, true),
		// The two 32-byte hashes sit little-endian inside the header; display them
		// byte-reversed (slice copies, so reverse() doesn't mutate the source bytes).
		prevHash: bytesToHex(bytes.slice(4, 36).reverse()),
		merkleRoot: bytesToHex(bytes.slice(36, 68).reverse()),
		time: dv.getUint32(68, true),
		bits,
		nonce: dv.getUint32(76, true),
		difficulty: bitsToDifficulty(bits),
		hash: blockHashFromHeader(headerHex)
	};
}

/** Whole-BTC float (as Electrum's verbose tx reports values) → integer sats. */
function btcToSats(btc: number): number {
	return Math.round(btc * 1e8);
}

/**
 * Loose shape of a decoded transaction from Electrum's
 * `blockchain.transaction.get(txid, verbose=true)` (the backend daemon's
 * getrawtransaction verbose format). Output values are BTC (not sats); inputs
 * carry only a prevout reference (txid + vout), so attributing the spent side to
 * an address means resolving each referenced prev-tx.
 */
interface VerboseTxVout {
	value: number; // BTC
	scriptPubKey?: { hex?: string; address?: string; addresses?: string[] };
}
interface VerboseTxVin {
	txid?: string;
	vout?: number;
	coinbase?: string;
}
interface VerboseTx {
	txid?: string;
	vin: VerboseTxVin[];
	vout: VerboseTxVout[];
	blocktime?: number;
	time?: number;
}

function detectAddressType(address: string): string | null {
	if (/^1/.test(address)) return 'p2pkh';
	if (/^3/.test(address)) return 'p2sh';
	const lower = address.toLowerCase();
	if (lower.startsWith('bc1q')) return lower.length === 42 ? 'p2wpkh' : 'p2wsh';
	if (lower.startsWith('bc1p')) return 'p2tr';
	return null;
}

function round2(n: number): number {
	return Math.round(n * 100) / 100;
}

/** Max Bitcoin block weight (weight units). Fullness = weight ÷ this, clamped 0..1. */
const MAX_BLOCK_WEIGHT = 4_000_000;

/** Block fullness 0..1 from weight; null when weight is unknown (Cardinal rule). */
function fullnessFromWeight(weight: number | null): number | null {
	return typeof weight === 'number' ? Math.min(1, weight / MAX_BLOCK_WEIGHT) : null;
}

/** Concurrency cap for the recent-blocks getblockstats fan-out (Wave 1, U1). */
const RECENT_BLOCK_STATS_CONCURRENCY = 12;

/** getblockstats fields the recent-blocks enrichment requests (fee amounts already
 *  in sats). Kept minimal so Core returns only what the row model consumes. */
const RECENT_BLOCK_STATS_FIELDS = [
	'txs',
	'total_size',
	'total_weight',
	'total_out',
	'totalfee',
	'subsidy',
	'feerate_percentiles'
];

/**
 * Normalized subset of `getblockstats` the block-list row model consumes. Sits
 * between the raw Core shape and the immutable blockStatsCache (chain/cache.ts) so
 * the cache never stores a Core-specific object. Amounts are in sats.
 */
export interface BlockStats {
	txCount: number | null;
	size: number | null; // bytes
	weight: number | null; // weight units
	total_out: number | null; // sats
	medianFee: number | null; // sat/vB
	feeRange: [number, number] | null; // sat/vB
}

/** Map a raw `getblockstats` result to the normalized {@link BlockStats}; null when absent. */
function normalizeBlockStats(s: CoreBlockStats | null | undefined): BlockStats | null {
	if (!s) return null;
	const pct = s.feerate_percentiles;
	const medianFee = Array.isArray(pct) && pct.length >= 3 ? round2(pct[2]) : null;
	const feeRange: [number, number] | null =
		Array.isArray(pct) && pct.length >= 5 ? [round2(pct[0]), round2(pct[4])] : null;
	return {
		txCount: typeof s.txs === 'number' ? s.txs : null,
		size: typeof s.total_size === 'number' ? s.total_size : null,
		weight: typeof s.total_weight === 'number' ? s.total_weight : null,
		total_out: typeof s.total_out === 'number' ? s.total_out : null,
		medianFee,
		feeRange
	};
}

/** Overlay enrichment stats onto a baseline block row (in place). */
function applyBlockStats(row: BlockSummary, s: BlockStats): void {
	row.txCount = s.txCount;
	row.size = s.size;
	row.weight = s.weight;
	row.total_out = s.total_out;
	row.medianFee = s.medianFee;
	row.feeRange = s.feeRange;
	row.fullness = fullnessFromWeight(s.weight);
}

/**
 * Run `fn` over every item with at most `limit` in flight at once. `fn` handles
 * its own errors (a per-item catch), so one failure never aborts the batch.
 */
async function mapWithConcurrency<T>(
	items: T[],
	limit: number,
	fn: (item: T) => Promise<void>
): Promise<void> {
	let cursor = 0;
	const worker = async () => {
		while (cursor < items.length) {
			await fn(items[cursor++]);
		}
	};
	const n = Math.min(Math.max(1, limit), items.length);
	await Promise.all(Array.from({ length: n }, () => worker()));
}

// --------------------------------------------------------- Bitcoin Core mapping

/**
 * Loose shape of a decoded transaction from Bitcoin Core's
 * `getrawtransaction(txid, verbosity)`. At verbosity 2/3 each non-coinbase input
 * carries a `prevout` (with the spent output's value in BTC + scriptPubKey), so
 * the fee and the input addresses/values can be computed without a second lookup.
 * Values are BTC floats (not sats) — always convert with btcToSats.
 */
interface CoreScriptPubKey {
	hex?: string;
	address?: string;
	addresses?: string[];
	type?: string;
}
interface CoreTxVout {
	value: number; // BTC
	n?: number;
	scriptPubKey?: CoreScriptPubKey;
}
interface CoreTxPrevout {
	generated?: boolean;
	height?: number;
	value?: number; // BTC
	scriptPubKey?: CoreScriptPubKey;
}
interface CoreTxVin {
	txid?: string;
	vout?: number;
	coinbase?: string;
	scriptSig?: { hex?: string };
	sequence?: number;
	txinwitness?: string[];
	prevout?: CoreTxPrevout;
}
interface CoreRawTx {
	txid: string;
	hash?: string;
	version: number;
	size: number;
	vsize: number;
	weight: number;
	locktime: number;
	vin: CoreTxVin[];
	vout: CoreTxVout[];
	blockhash?: string;
	confirmations?: number;
	time?: number;
	blocktime?: number;
}

/** Bitcoin Core `getblock(hash, 1)` — decoded header + txid list + size/weight. */
interface CoreBlock {
	hash: string;
	confirmations?: number;
	height: number;
	version: number;
	merkleroot: string;
	time: number;
	nonce: number;
	bits: string; // hex string already
	difficulty: number;
	nTx: number;
	previousblockhash?: string;
	size: number;
	weight: number;
	tx: string[];
}

/** Subset of `getblockstats` fields we consume (fee amounts already in sats). */
interface CoreBlockStats {
	txs?: number; // transaction count
	total_size?: number; // bytes
	total_weight?: number; // weight units
	total_out?: number; // sats — sum of all output values
	feerate_percentiles?: number[]; // [10,25,50,75,90] sat/vB
	totalfee?: number; // sats
	subsidy?: number; // sats
}

/**
 * Map a Bitcoin Core decoded transaction to the app's TxDetail shape. Values are
 * converted BTC→sats. When `block` is supplied (block-tx listing) the tx is known
 * to be confirmed in that block, so height/hash/time come from it; otherwise they
 * are derived from the tx's own `confirmations`/`blockhash`. `outspends` (from
 * per-output gettxout) sets each vout's spent flag; absent → null (unknown).
 */
function toTxDetailFromCore(
	tx: CoreRawTx,
	opts: {
		tipHeight?: number | null;
		outspends?: (boolean | null)[];
		block?: { height: number; hash: string; time: number };
	} = {}
): TxDetail {
	const coinbase = tx.vin.some((v) => typeof v.coinbase === 'string');
	const confirmations = typeof tx.confirmations === 'number' ? tx.confirmations : 0;
	const confirmed = opts.block !== undefined || confirmations > 0 || !!tx.blockhash;

	let blockHeight: number | null;
	let blockHash: string | null;
	let blockTime: number | null;
	let confs: number;
	if (opts.block) {
		blockHeight = opts.block.height;
		blockHash = opts.block.hash;
		blockTime = opts.block.time;
		confs =
			opts.tipHeight != null ? Math.max(1, opts.tipHeight - opts.block.height + 1) : confirmations;
	} else {
		// Core doesn't return height directly; derive it from tip − confirmations + 1.
		blockHeight =
			confirmed && opts.tipHeight != null && confirmations > 0
				? opts.tipHeight - confirmations + 1
				: null;
		blockHash = tx.blockhash ?? null;
		blockTime = tx.blocktime ?? null;
		confs = confirmed ? confirmations : 0;
	}

	// Fee = Σ prevout − Σ vout, computable only when every prevout is present
	// (verbosity 2/3). Coinbase has no fee.
	let fee: number | null = null;
	if (!coinbase && tx.vin.length > 0) {
		let totalIn = 0;
		let known = true;
		for (const v of tx.vin) {
			if (v.prevout && typeof v.prevout.value === 'number') totalIn += btcToSats(v.prevout.value);
			else {
				known = false;
				break;
			}
		}
		if (known) {
			const totalOut = tx.vout.reduce((s, o) => s + btcToSats(o.value), 0);
			fee = totalIn - totalOut;
		}
	}

	const vin: TxVin[] = tx.vin.map((v) => {
		if (typeof v.coinbase === 'string') {
			return {
				txid: null,
				vout: null,
				address: null,
				value: null,
				prevScriptPubKey: null,
				coinbase: true,
				scriptSig: v.coinbase || null,
				witness: v.txinwitness?.length ? v.txinwitness : null
			};
		}
		const po = v.prevout;
		const spk = po?.scriptPubKey;
		return {
			txid: v.txid ?? null,
			vout: v.vout ?? null,
			address: spk?.address ?? spk?.addresses?.[0] ?? null,
			value: po && typeof po.value === 'number' ? btcToSats(po.value) : null,
			prevScriptPubKey: spk?.hex ?? null,
			coinbase: false,
			scriptSig: v.scriptSig?.hex || null,
			witness: v.txinwitness?.length ? v.txinwitness : null
		};
	});

	const vout: TxVout[] = tx.vout.map((v, i) => {
		const spk = v.scriptPubKey;
		return {
			address: spk?.address ?? spk?.addresses?.[0] ?? null,
			value: btcToSats(v.value),
			scriptType: spk?.type ?? 'unknown',
			scriptPubKey: spk?.hex ?? '',
			spent: opts.outspends?.[i] ?? null
		};
	});

	const segwit = tx.vin.some((v) => (v.txinwitness?.length ?? 0) > 0) || tx.weight < tx.size * 4;
	const rbf = !coinbase && tx.vin.some((v) => (v.sequence ?? 0xffffffff) < 0xfffffffe);
	const vsize = tx.vsize;

	return {
		txid: tx.txid,
		confirmed,
		blockHeight,
		blockHash,
		blockTime,
		confirmations: confs,
		size: tx.size,
		vsize,
		weight: tx.weight,
		fee,
		feeRate: fee !== null && vsize > 0 ? round2(fee / vsize) : null,
		locktime: tx.locktime,
		version: tx.version,
		segwit,
		rbf,
		vin,
		vout
	};
}

/**
 * Approximate mempool.space-style projected blocks from an Electrum fee histogram
 * (`mempool.get_fee_histogram`: [feeRate sat/vB, vsize] pairs, highest rate
 * first). Greedily fills 1,000,000-vB (one block's worth of virtual weight) blocks
 * from the highest-fee backlog down; the final block absorbs the remaining tail.
 * Approximate by design (cairn-zoz8.14) — nTx is estimated from vsize, medianFee
 * is the vsize-weighted mean of the block's fee rates.
 */
function projectBlocksFromHistogram(hist: FeeHistogram): MempoolBlockProjection[] {
	const BLOCK_VSIZE = 1_000_000;
	const MAX_BLOCKS = 8;
	const AVG_TX_VSIZE = 250; // rough — histogram carries no tx count
	interface Bucket {
		vsize: number;
		fees: number;
		min: number;
		max: number;
	}
	const blocks: Bucket[] = [];
	let cur: Bucket = { vsize: 0, fees: 0, min: Infinity, max: 0 };
	const flush = () => {
		if (cur.vsize > 0) blocks.push(cur);
		cur = { vsize: 0, fees: 0, min: Infinity, max: 0 };
	};
	for (const entry of hist) {
		if (!Array.isArray(entry) || entry.length < 2) continue;
		const rate = entry[0];
		let vs = entry[1];
		if (!(rate > 0) || !(vs > 0)) continue;
		while (vs > 0) {
			// Once we're on the final allowed block, pour everything remaining into it.
			if (blocks.length >= MAX_BLOCKS - 1) {
				cur.vsize += vs;
				cur.fees += rate * vs;
				cur.min = Math.min(cur.min, rate);
				cur.max = Math.max(cur.max, rate);
				vs = 0;
				break;
			}
			const space = BLOCK_VSIZE - cur.vsize;
			const take = Math.min(vs, space);
			cur.vsize += take;
			cur.fees += rate * take;
			cur.min = Math.min(cur.min, rate);
			cur.max = Math.max(cur.max, rate);
			vs -= take;
			if (cur.vsize >= BLOCK_VSIZE) flush();
		}
	}
	flush();
	return blocks.map((b) => {
		const lo = b.min === Infinity ? b.max : b.min;
		return {
			nTx: Math.max(1, Math.round(b.vsize / AVG_TX_VSIZE)),
			vsize: b.vsize,
			totalFees: Math.round(b.fees),
			medianFee: round2(b.vsize > 0 ? b.fees / b.vsize : 0),
			feeRange: [round2(lo), round2(b.max)]
		};
	});
}

// ------------------------------------------------------------------ ChainService

export class ChainService {
	// A pool of Electrum connections behind one ElectrumClient-shaped facade, so
	// concurrent lookups fan out across sockets instead of queuing on one
	// (cairn-ynfp). Subscriptions stay on the pool's primary connection; every
	// call site is unaware it's pooled.
	readonly electrum: ElectrumPool;
	/**
	 * The operator's own Bitcoin Core node over JSON-RPC — the primary source for
	 * full block/tx detail, per-output spent-ness, mempool summary and CPFP. Null
	 * when no coreRpcUrl is configured; the Electrum-backed methods keep working
	 * and the Core-backed ones degrade (return null / throw a clear "needs Core
	 * RPC" error the routes surface as the CoreRpcRequiredNotice empty-state).
	 */
	readonly core: CoreRpcClient | null;
	private readonly config: ReturnType<typeof getChainConfig>;

	constructor(config = getChainConfig()) {
		this.config = config;
		// Record whether chain traffic is routed through a SOCKS5/Tor proxy, so the
		// transport-health signal can tell users a misconfigured proxy (not the node)
		// is the likely cause of an outage (cairn-hy8z).
		noteProxyConfigured(!!(config.socks5Host && config.socks5Port));
		this.electrum = new ElectrumPool(
			{
				host: config.electrumHost,
				port: config.electrumPort,
				tls: config.electrumTls,
				tlsInsecure: config.electrumTlsInsecure,
				socks5Host: config.socks5Host,
				socks5Port: config.socks5Port
			},
			config.electrumPoolSize
		);
		// Surface connect/disconnect/new-block on the user activity feed + server log.
		wireChainEvents(this.electrum);
		this.core = config.coreRpcUrl
			? new CoreRpcClient({
					url: config.coreRpcUrl,
					user: config.coreRpcUser,
					pass: config.coreRpcPass,
					socks5Host: config.socks5Host,
					socks5Port: config.socks5Port,
					// Feed a Core-scoped reachability signal so NodeTrust can honestly say
					// "Verified by your Bitcoin Core node" when Core is the live source even
					// while Electrum is down, instead of a false "unreachable" (cairn-7qmw).
					onResult: (ok, err) => (ok ? recordCoreOk() : recordCoreError(err))
				})
			: null;
	}

	/** Whether a Bitcoin Core RPC backend is configured on this service. */
	get coreConfigured(): boolean {
		return this.core !== null;
	}

	close(): void {
		this.electrum.close();
		this.core?.close();
	}

	// ------------------------------------------------------------- explorer data

	async getTip(): Promise<{ height: number; hash: string }> {
		// TTL-cached (10min ceiling, invalidated on every 'header' event) so the
		// several call sites that fire on one navigation — and concurrent tabs —
		// share one Electrum round-trip instead of each paying for it.
		return cachedTip(async () => {
			// headersSubscribe returns the current tip {height, hex}; the hash is the
			// double-sha256 of the header (blockHashFromHeader). Same source
			// getNodeInfo already uses — no third-party HTTP explorer call (cairn-zoz8.5).
			const header = await this.electrum.headersSubscribe();
			return { height: header.height, hash: blockHashFromHeader(header.hex) };
		});
	}

	/**
	 * Recent blocks, newest first. The baseline comes from the operator's own
	 * Electrum server (`blockchain.block.header` per height, fetched concurrently)
	 * instead of a third-party HTTP explorer API (cairn-zoz8.5). A raw 80-byte header
	 * carries only version/prevhash/merkleroot/time/bits/nonce — NOT tx_count / size
	 * / weight or fee stats — so those stay **null** in the Electrum-only baseline
	 * (Cardinal rule: unknown reads as unknown, never a false 0).
	 *
	 * When Bitcoin Core RPC is configured, each row is enriched with `getblockstats`
	 * aggregates, fanned out at a concurrency cap. A per-block stats failure (e.g. a
	 * pruned node missing an old block) degrades THAT row back to the null baseline
	 * — it never throws and never fails the whole list (cairn-6efi.1, U1).
	 */
	async getRecentBlocks(limit = 10, fromHeight?: number): Promise<BlockSummary[]> {
		const top = fromHeight ?? (await this.getTip()).height;
		if (!Number.isFinite(top) || top < 0) return [];
		const count = Math.min(limit, top + 1);
		const heights = Array.from({ length: count }, (_, i) => top - i);
		const headers = await Promise.all(heights.map((h) => this.electrum.getBlockHeader(h)));
		const rows: BlockSummary[] = headers.map((hex, i) => {
			const d = decodeBlockHeader(hex);
			return {
				height: heights[i],
				hash: d.hash,
				time: d.time,
				txCount: null,
				size: null,
				weight: null,
				medianFee: null,
				feeRange: null,
				total_out: null,
				fullness: null
			};
		});

		const core = this.core;
		if (core) {
			await mapWithConcurrency(rows, RECENT_BLOCK_STATS_CONCURRENCY, async (row) => {
				// Stats and pool are independent enrichments — a failure of one must not
				// suppress the other, so each carries its own catch and degrades only its
				// own fields. Both are immutable-cached by hash, so steady-state only the
				// newly-arrived tip block actually hits Core (cairn-6efi.1/.4).
				try {
					const stats = await this.getRecentBlockStats(core, row.hash);
					if (stats) applyBlockStats(row, stats);
				} catch (e) {
					// Pruned node / disabled getblockstats / transient RPC error: leave
					// this row at its null baseline rather than failing the whole list.
					log.debug({ err: e, height: row.height }, 'getblockstats enrichment failed; row stays null');
				}
				try {
					row.pool = await this.identifyBlockPool(core, row.hash);
				} catch (e) {
					// Coinbase lookup failed — leave pool undefined (unknown), never guess.
					log.debug({ err: e, height: row.height }, 'pool identification failed; row stays null');
				}
			});
		}
		return rows;
	}

	/**
	 * Identify a block's mining pool from its coinbase (cairn-6efi.4, T-C), served
	 * from the immutable poolCache when present. A buried block's coinbase never
	 * changes, so a cache hit — including a cached "no known pool" (null) — is
	 * always correct; this keeps the steady-state SWR refresh to a single new-tip
	 * pool lookup. Two RPCs on a miss: getblock(hash,1) for the coinbase txid, then
	 * getrawtransaction(txid, 2, hash) for the coinbase scriptSig + payout outputs
	 * (verbosity 2, blockhash-scoped so it needs no txindex; older Core rejecting
	 * `2` falls back to verbose=true — enough for the coinbase tag). Returns null
	 * for any unknown coinbase so the UI shows nothing rather than a wrong pool.
	 */
	private async identifyBlockPool(core: CoreRpcClient, hash: string): Promise<BlockPool | null> {
		const cached = getCachedPool(hash);
		if (cached) return cached.pool;

		const block = (await core.getBlock(hash, 1)) as CoreBlock;
		const coinbaseTxid = Array.isArray(block.tx) ? block.tx[0] : undefined;
		if (!coinbaseTxid) {
			cachePool(hash, null);
			return null;
		}

		let raw: CoreRawTx;
		try {
			raw = await core.call<CoreRawTx>('getrawtransaction', [coinbaseTxid, 2, hash]);
		} catch (e) {
			if (!(e instanceof CoreRpcError)) throw e;
			raw = await core.call<CoreRawTx>('getrawtransaction', [coinbaseTxid, true, hash]);
		}

		const coinbaseHex = raw.vin?.[0]?.coinbase ?? null;
		const outputAddrs = (raw.vout ?? []).map(
			(v) => v.scriptPubKey?.address ?? v.scriptPubKey?.addresses?.[0] ?? null
		);
		const pool = identifyPool(coinbaseHex, outputAddrs);
		cachePool(hash, pool);
		return pool;
	}

	/**
	 * Fetch + normalize one block's `getblockstats` aggregates, served from the
	 * immutable blockStatsCache when present (cairn-6efi.1, U1+U2). A confirmed
	 * block's stats never change, so a cache hit is always correct — this is what
	 * keeps the steady-state SWR refresh to a single new-tip stats fetch (U4).
	 */
	private async getRecentBlockStats(core: CoreRpcClient, hash: string): Promise<BlockStats | null> {
		const cached = getCachedBlockStats(hash);
		if (cached) return cached;
		const raw = (await core.getBlockStats(hash, RECENT_BLOCK_STATS_FIELDS)) as CoreBlockStats;
		const stats = normalizeBlockStats(raw);
		if (stats) cacheBlockStats(hash, stats);
		return stats;
	}

	/**
	 * Full block detail. Sourced from the operator's own Bitcoin Core node
	 * (`getblockhash` + `getblock` verbosity 1, plus `getblockstats` for fee/reward
	 * stats), otherwise throwing a clear "needs Core RPC" error the block route
	 * renders as the CoreRpcRequiredNotice empty-state (cairn-zoz8.10). Throws a
	 * not-found error for an unknown hash/height so the search classifier can fall
	 * through.
	 */
	async getBlock(hashOrHeight: string | number): Promise<BlockDetail> {
		if (this.core) {
			try {
				return await this.getBlockViaCore(this.core, hashOrHeight);
			} catch (e) {
				if (e instanceof CoreRpcError && (e.code === -5 || e.code === -8)) {
					throw new Error(`Block not found: ${hashOrHeight}`);
				}
				throw e;
			}
		}
		throw new Error(
			'Block detail requires a Bitcoin Core RPC connection (configure it in admin settings).'
		);
	}

	private async getBlockViaCore(
		core: CoreRpcClient,
		hashOrHeight: string | number
	): Promise<BlockDetail> {
		const hash =
			typeof hashOrHeight === 'number' || /^\d{1,7}$/.test(String(hashOrHeight))
				? await core.getBlockHash(Number(hashOrHeight))
				: String(hashOrHeight);
		const b = (await core.getBlock(hash, 1)) as CoreBlock;

		// Fee/reward stats are best-effort: getblockstats can be slow on very old
		// blocks and is absent on pruned nodes below the block. Degrade to null.
		let stats: CoreBlockStats | null = null;
		try {
			stats = (await core.getBlockStats(hash, [
				'total_out',
				'feerate_percentiles',
				'totalfee',
				'subsidy'
			])) as CoreBlockStats;
		} catch (e) {
			log.debug({ err: e, height: b.height }, 'getblockstats unavailable (fees/reward null)');
		}
		const pct = stats?.feerate_percentiles;
		const medianFee = Array.isArray(pct) && pct.length >= 3 ? round2(pct[2]) : null;
		const feeRange: [number, number] | null =
			Array.isArray(pct) && pct.length >= 5 ? [round2(pct[0]), round2(pct[4])] : null;
		const totalFees = typeof stats?.totalfee === 'number' ? stats.totalfee : null;
		const subsidy = typeof stats?.subsidy === 'number' ? stats.subsidy : null;
		const reward = totalFees !== null && subsidy !== null ? subsidy + totalFees : null;

		return {
			height: b.height,
			hash: b.hash,
			time: b.time,
			txCount: b.nTx,
			size: b.size,
			weight: b.weight,
			medianFee,
			feeRange,
			total_out: typeof stats?.total_out === 'number' ? stats.total_out : null,
			fullness: fullnessFromWeight(typeof b.weight === 'number' ? b.weight : null),
			// Miner attribution needs a maintained coinbase-tag database Cairn doesn't
			// ship (cairn-zoz8.10) — omit rather than guess.
			miner: undefined,
			prevHash: b.previousblockhash ?? null,
			merkleRoot: b.merkleroot,
			nonce: b.nonce,
			bits: b.bits, // Core returns nBits as a hex string already
			difficulty: b.difficulty,
			version: b.version,
			totalFees,
			reward
		};
	}

	/** Transactions of a block, 25 per page (page is 0-based). */
	async getBlockTxs(hash: string, page = 0): Promise<{ txs: TxDetail[]; total: number }> {
		if (this.core) {
			return this.getBlockTxsViaCore(this.core, hash, page);
		}
		throw new Error(
			'Block transactions require a Bitcoin Core RPC connection (configure it in admin settings).'
		);
	}

	private async getBlockTxsViaCore(
		core: CoreRpcClient,
		hash: string,
		page: number
	): Promise<{ txs: TxDetail[]; total: number }> {
		const b = (await core.getBlock(hash, 1)) as CoreBlock;
		const txids = Array.isArray(b.tx) ? b.tx : [];
		const total = typeof b.nTx === 'number' ? b.nTx : txids.length;
		// Every tx here is confirmed in THIS block, so pass the block context (no
		// per-tx height guess) and derive tipHeight from the block's confirmations.
		const tipHeight =
			typeof b.confirmations === 'number' ? b.height + b.confirmations - 1 : null;
		const blockCtx = { height: b.height, hash: b.hash, time: b.time };
		const slice = txids.slice(page * BLOCK_TXS_PAGE_SIZE, page * BLOCK_TXS_PAGE_SIZE + BLOCK_TXS_PAGE_SIZE);
		const txs = await Promise.all(
			slice.map(async (txid) => {
				// Passing the blockhash resolves any tx in the block WITHOUT needing
				// txindex; verbosity 2 includes prevout so per-tx fees are exact. Older
				// Core (pre-verbosity-int) rejects `2` — retry with verbose=true.
				let raw: CoreRawTx;
				try {
					raw = await core.call<CoreRawTx>('getrawtransaction', [txid, 2, hash]);
				} catch (e) {
					if (!(e instanceof CoreRpcError)) throw e;
					raw = await core.call<CoreRawTx>('getrawtransaction', [txid, true, hash]);
				}
				return toTxDetailFromCore(raw, { tipHeight, block: blockCtx });
			})
		);
		return { txs, total };
	}

	/**
	 * Full transaction detail. Sourced from the operator's own Bitcoin Core node
	 * (`getrawtransaction` verbosity 2 — decoded, with prevout so fee + input
	 * addresses are exact — plus per-output `gettxout` for spent-ness). Throws a
	 * not-found error for an unknown txid so the search classifier and tx route can
	 * handle it. A -5/-8 from Core covers both "genuinely no such tx" and "this tx
	 * isn't in the mempool/wallet and Core has no -txindex to look up an arbitrary
	 * confirmed one" — either way it surfaces as not-found (an operator who wants
	 * arbitrary historical tx lookups runs Core with -txindex).
	 */
	async getTx(txid: string): Promise<TxDetail> {
		if (this.core) {
			try {
				return await this.getTxViaCore(this.core, txid);
			} catch (e) {
				if (e instanceof CoreRpcError && (e.code === -5 || e.code === -8)) {
					throw new Error(`Transaction not found: ${txid}`);
				}
				throw e;
			}
		}
		// Electrum-only fallback (docs/TX-BLOCK-CONTEXT-DESIGN.md §2): with no Core RPC
		// configured, a full-indexing Electrum server (electrs / Fulcrum) still decodes
		// any confirmed or mempool tx, so the tx page — and its block-context section —
		// render at the 'basic' tier instead of the CoreRpcRequiredNotice. Near-zero new
		// mapping code: the verbose result is Core's getrawtransaction shape exactly.
		return this.getTxViaElectrum(txid);
	}

	/**
	 * Decode a transaction from the operator's own Electrum server via
	 * `blockchain.transaction.get(txid, verbose=true)` (docs/TX-BLOCK-CONTEXT-DESIGN.md
	 * §2). A full-indexing backend returns Bitcoin Core's `getrawtransaction verbose`
	 * JSON exactly, which maps through the existing {@link toTxDetailFromCore}. There
	 * is no prevout at this verbosity, so `fee` and input addresses/values degrade to
	 * null (same as the older-Core verbose=true path); everything the block-context
	 * feature needs — blockhash / blocktime / confirmations / size / vsize — is
	 * present. An unknown txid ("No such mempool or blockchain transaction…") maps to
	 * the same not-found signal Core uses so the route/search handling is uniform.
	 */
	private async getTxViaElectrum(txid: string): Promise<TxDetail> {
		let raw: CoreRawTx;
		try {
			raw = (await this.electrum.getTransaction(txid, true)) as CoreRawTx;
		} catch (e) {
			if (/no such|not found/i.test(String(e))) throw new Error(`Transaction not found: ${txid}`);
			throw e;
		}
		const tipHeight = await this.getTip()
			.then((t) => t.height)
			.catch(() => null);
		return toTxDetailFromCore(raw, { tipHeight });
	}

	/**
	 * Assemble the block context behind a transaction's detail page
	 * (docs/TX-BLOCK-CONTEXT-DESIGN.md §3): the block it landed in, its 1–3 neighbours
	 * with dates, the tx's position within its block, and — with Core — per-block
	 * tx-count / size / fullness aggregates.
	 *
	 * Progressive enhancement, and it NEVER throws — it resolves to `richness:'none'`
	 * on a total backend failure so the UI shows an honest "connecting" state instead
	 * of an error:
	 *   - tip unreachable                 → 'none'
	 *   - Electrum decodes the tx         → 'basic' (dates + exact position + summary)
	 *   - Core also answers getblockstats → 'full'  (+ counts/size/fullness, exact total)
	 *
	 * Position always comes from Electrum's merkle proof (cheap and exact) in every
	 * tier; Core is used only for the immutable-cached getblockstats aggregate — no
	 * `getblock` v1 whole-block fan-out just to locate one index (§1 rationale).
	 */
	async getTxBlockContext(txid: string): Promise<BlockContext> {
		const coreConfigured = this.core !== null;
		const none = (): BlockContext => ({
			richness: 'none',
			confirmed: false,
			height: null,
			confirmations: null,
			tipHeight: null,
			position: null,
			positionTotal: null,
			positionEstimated: false,
			neighbors: [],
			vsize: null,
			fee: null,
			feeRate: null,
			coreConfigured
		});

		// 1. Tip — cached, the always-fresh source for confirmations. Sourced from
		//    Electrum; a Core-up / Electrum-down deployment recovers it from Core after
		//    the decode below (a confirmed tx's block height + confirmations pin the tip
		//    exactly), so this failure is not yet fatal (cairn-zc4x).
		let tipHeight: number | null = null;
		try {
			tipHeight = (await this.getTip()).height;
		} catch {
			tipHeight = null;
		}

		// 2. Decode the tx to learn confirmed-ness and its block anchoring. Prefer
		//    Electrum verbose (no txindex dependency); fall back to the operator's own
		//    Core node (`getrawtransaction` verbose — needs txindex) so a Core-up /
		//    Electrum-down deployment resolves a usable tier instead of the 'none'
		//    dead-end that contradicts the page's "Verified by your Bitcoin Core node"
		//    provenance (cairn-zc4x). `electrumOk` gates the merkle-position step below
		//    — the merkle proof is an Electrum-only capability with no Core equivalent.
		let raw: CoreRawTx;
		let electrumOk = false;
		try {
			raw = (await this.electrum.getTransaction(txid, true)) as CoreRawTx;
			electrumOk = true;
		} catch {
			const core = this.core;
			if (!core) return none();
			try {
				raw = (await core.getRawTransaction(txid, true)) as CoreRawTx;
			} catch {
				return none();
			}
		}
		const vsize = typeof raw.vsize === 'number' ? raw.vsize : null;
		const confirmations = typeof raw.confirmations === 'number' ? raw.confirmations : 0;
		const confirmed = confirmations > 0 && !!raw.blockhash;

		// Recover the tip from Core when Electrum couldn't supply it (Core-only path):
		// a confirmed tx's own block height plus its confirmations pins the tip exactly;
		// an unconfirmed tx falls back to getblockcount (cairn-zc4x).
		const coreForTip = this.core;
		if (tipHeight === null && coreForTip) {
			try {
				if (confirmed && raw.blockhash) {
					const hdr = await coreForTip.getBlockHeader(raw.blockhash, true);
					if (hdr && typeof hdr.height === 'number') {
						tipHeight = hdr.height + confirmations - 1;
					}
				} else {
					tipHeight = await coreForTip.getBlockCount();
				}
			} catch {
				tipHeight = null;
			}
		}
		// No tip from either backend ⇒ honest 'none' (can't place the tx on a rail).
		if (tipHeight === null) return none();

		// Mempool tx: no block row — honest "waiting" state. We reached the backend, so
		// this is 'basic' (an unconfirmed tx can never gain Core block enrichment).
		if (!confirmed) {
			return {
				richness: 'basic',
				confirmed: false,
				height: null,
				confirmations: 0,
				tipHeight,
				position: null,
				positionTotal: null,
				positionEstimated: false,
				neighbors: [],
				vsize,
				fee: null,
				feeRate: null,
				coreConfigured
			};
		}

		// 3. Center block height from the fresh tip (clamp a racey tip < height).
		let height = tipHeight - confirmations + 1;
		if (height > tipHeight) height = tipHeight;
		if (height < 0) height = 0;

		// 4. Neighbours [h-1, h, h+1] clamped to [0, tip]. Each header degrades on its
		//    own (hash/time null) without failing the row.
		const heights: number[] = [];
		for (const h of [height - 1, height, height + 1]) {
			if (h >= 0 && h <= tipHeight && !heights.includes(h)) heights.push(h);
		}
		const neighbors: BlockContextNeighbor[] = await Promise.all(
			heights.map(async (h): Promise<BlockContextNeighbor> => {
				const header = await this.neighborHeader(h, tipHeight);
				return {
					height: h,
					hash: header?.hash ?? null,
					time: header?.time ?? null,
					txCount: null,
					size: null,
					fullness: null,
					isCurrent: h === height
				};
			})
		);

		// 5. Position from the merkle proof (Electrum, exact) — only when Electrum
		//    decoded the tx. The merkle proof has no Core RPC equivalent, so a Core-only
		//    path honestly omits the position marker (position stays null → the UI hides
		//    the indicator) while still rendering the block rail (cairn-zc4x). The
		//    basic-tier denominator is estimated from proof depth; Core supplies the
		//    exact count in step 6.
		let position: number | null = null;
		let positionTotal: number | null = null;
		let positionEstimated = false;
		if (electrumOk) {
			const pos = await this.merklePos(txid, height);
			if (pos) {
				position = pos.pos;
				positionTotal = 2 ** pos.merkleDepth; // over-estimate; positionEstimated flags it
				positionEstimated = true;
			}
		}

		// 6. Core enrichment (full tier): per-block getblockstats aggregates, served from
		//    the immutable blockStatsCache shared with the explorer block list. The
		//    center block's exact tx count becomes the position denominator. Each block
		//    degrades on its own; a total Core outage simply keeps the 'basic' tier.
		let richness: 'basic' | 'full' = 'basic';
		const core = this.core;
		if (core) {
			await Promise.all(
				neighbors.map(async (n) => {
					if (!n.hash) return;
					try {
						const stats = await this.getRecentBlockStats(core, n.hash);
						if (!stats) return;
						n.txCount = stats.txCount;
						n.size = stats.size;
						n.fullness = fullnessFromWeight(stats.weight);
						richness = 'full';
						if (n.isCurrent && typeof stats.txCount === 'number') {
							positionTotal = stats.txCount; // exact denominator
							positionEstimated = false;
						}
					} catch {
						// Pruned node / disabled getblockstats: leave this block at the
						// basic-tier baseline (null counts) rather than failing the section.
					}
				})
			);
		}

		return {
			richness,
			confirmed: true,
			height,
			confirmations: Math.max(1, tipHeight - height + 1), // recomputed fresh
			tipHeight,
			position,
			positionTotal,
			positionEstimated,
			neighbors,
			vsize,
			fee: null,
			feeRate: null,
			coreConfigured
		};
	}

	/** One neighbour block's (hash, time), reorg-window-cached by height
	 *  (chain/cache.ts). Degrades to null on any header failure — the caller renders
	 *  that cell with its height only. */
	private async neighborHeader(
		height: number,
		tipHeight: number
	): Promise<{ hash: string; time: number } | null> {
		const dist = tipHeight - height;
		const cached = getCachedHeader(height, dist);
		if (cached) return cached;
		// Prefer Electrum's raw header. Fall back to the operator's own Core node
		// (getblockhash + getblockheader) so neighbours still resolve in a Core-up /
		// Electrum-down deployment — otherwise the block rail would render height-only
		// cells with no dates (cairn-zc4x).
		try {
			const d = decodeBlockHeader(await this.electrum.getBlockHeader(height));
			const value = { hash: d.hash, time: d.time };
			cacheHeader(height, value);
			return value;
		} catch {
			// fall through to Core
		}
		const core = this.core;
		if (core) {
			try {
				const hash = await core.getBlockHash(height);
				const hdr = await core.getBlockHeader(hash, true);
				if (hdr && typeof hdr.hash === 'string' && typeof hdr.time === 'number') {
					const value = { hash: hdr.hash, time: hdr.time };
					cacheHeader(height, value);
					return value;
				}
			} catch {
				// degrade to null — the cell renders with its height only
			}
		}
		return null;
	}

	/** The tx's merkle position within its block, immutable-cached by (txid, height)
	 *  (chain/cache.ts). `merkleDepth` is the proof length — `2 ** depth` is the
	 *  basic-tier denominator estimate. Null when the server lacks get_merkle or the
	 *  proof fails; the position marker is then simply hidden. */
	private async merklePos(
		txid: string,
		height: number
	): Promise<{ pos: number; merkleDepth: number } | null> {
		const cached = getCachedMerklePos(txid, height);
		if (cached) return cached;
		try {
			const proof = await this.electrum.getMerkleProof(txid, height);
			const value = {
				pos: proof.pos,
				merkleDepth: Array.isArray(proof.merkle) ? proof.merkle.length : 0
			};
			cacheMerklePos(txid, height, value);
			return value;
		} catch {
			return null;
		}
	}

	private async getTxViaCore(core: CoreRpcClient, txid: string): Promise<TxDetail> {
		// verbosity 2 gives decoded tx + prevout on each input (Core 25+). Older
		// nodes reject `2` (expect a bool) — retry decoded (verbose=true), which
		// loses prevout so fee/input-values degrade to null but the tx still renders.
		let tx: CoreRawTx;
		try {
			tx = await core.call<CoreRawTx>('getrawtransaction', [txid, 2]);
		} catch (e) {
			if (e instanceof CoreRpcError && (e.code === -5 || e.code === -8)) throw e;
			tx = (await core.getRawTransaction(txid, true)) as CoreRawTx;
		}
		const [tipHeight, outspends] = await Promise.all([
			this.getTip()
				.then((t) => t.height)
				.catch(() => null),
			this.coreOutspends(core, txid, tx.vout.length)
		]);
		return toTxDetailFromCore(tx, { tipHeight, outspends });
	}

	/**
	 * Per-output spent-ness via Bitcoin Core `gettxout` (cairn-zoz8.11): null means
	 * the output is spent or nonexistent — and since we already fetched this tx, it
	 * exists, so null ⇒ spent. include_mempool=true so a mempool spend counts.
	 * Concurrent, capped (a monster tx must not fan out into hundreds of RPCs), and
	 * degrades any per-output failure to null (unknown). Core cannot report WHO
	 * spent it — the UI contract is spent-boolean-only, no spender link.
	 */
	private async coreOutspends(
		core: CoreRpcClient,
		txid: string,
		voutCount: number
	): Promise<(boolean | null)[] | undefined> {
		const MAX_OUTPUTS = 100;
		if (voutCount === 0 || voutCount > MAX_OUTPUTS) return undefined;
		try {
			return await Promise.all(
				Array.from({ length: voutCount }, (_, n) =>
					core
						.getTxOut(txid, n, true)
						.then((o): boolean | null => o === null)
						.catch((): boolean | null => null)
				)
			);
		} catch (e) {
			log.debug({ err: e, txid }, 'core outspends unavailable; spent-ness degraded to null');
			return undefined;
		}
	}

	/**
	 * Raw serialization of a transaction, hex.
	 *
	 * Sourced from the operator's own Electrum server via
	 * `blockchain.transaction.get(txid, verbose=false)` rather than a third-party
	 * HTTP explorer API (cairn-zoz8.4) — a full-indexing Electrum backend
	 * (ElectrumX/Fulcrum/electrs) returns the raw hex for any confirmed or mempool
	 * txid, not just wallet-owned ones. Throws when the server can't produce the
	 * hex (tx not found, or a non-indexing server), a stable contract so callers'
	 * existing try/catch handling is unchanged.
	 *
	 * Cross-build LRU cached by txid (cache.ts, cairn perf: send-flow prev-tx
	 * fetch): a confirmed tx's bytes never change, so repeated builds (a user
	 * adjusting amount/fee and rebuilding) or repeated fee-bump lookups reuse
	 * the same fetch instead of round-tripping Electrum again.
	 */
	async getTxHex(txid: string): Promise<string> {
		const cached = getCachedRawTx(txid);
		if (cached !== undefined) return cached;
		const hex = String(await this.electrum.getTransaction(txid, false));
		cacheRawTx(txid, hex);
		return hex;
	}

	/**
	 * Replace-by-fee timeline for a transaction, oldest version first — always null
	 * for now. Bitcoin Core exposes no HISTORICAL replacement lineage (only whether
	 * a live mempool tx is bip125-replaceable, which TxDetail.rbf already carries
	 * from the input sequences), and there is no external index to read a
	 * replacement chain from. A real chain needs a forward-looking,
	 * Core-based watcher that records old→new txids as they happen — deferred as
	 * cairn-zoz8.13. The tx page's RBF section is already gated on a null result, so
	 * returning null here degrades cleanly.
	 */
	async getTxRbfInfo(_txid: string): Promise<RbfInfo | null> {
		return null;
	}

	/**
	 * CPFP package context for an unconfirmed tx; null when not applicable.
	 * Sourced from the operator's own Bitcoin Core mempool
	 * (`getmempoolentry` + `getmempoolancestors`/`getmempooldescendants`,
	 * cairn-zoz8.12). A confirmed/unknown tx (not in the mempool), or no Core RPC
	 * configured, yields null.
	 */
	async getCpfpInfo(txid: string): Promise<CpfpInfo | null> {
		if (!this.core) return null;
		try {
			return await this.getCpfpViaCore(this.core, txid);
		} catch (e) {
			// -5 (not in mempool) is the normal confirmed/unknown case → no CPFP.
			if (e instanceof CoreRpcError && (e.code === -5 || e.code === -8)) return null;
			log.debug({ err: e, txid }, 'core CPFP lookup failed; no CPFP context');
			return null;
		}
	}

	private async getCpfpViaCore(core: CoreRpcClient, txid: string): Promise<CpfpInfo | null> {
		// getmempoolentry throws -5 when the tx isn't in the mempool (confirmed or
		// unknown) — the caller maps that to null.
		const entry = await core.getMempoolEntry(txid);
		const [anc, desc] = await Promise.all([
			core.call<string[]>('getmempoolancestors', [txid]).catch(() => [] as string[]),
			core.call<string[]>('getmempooldescendants', [txid]).catch(() => [] as string[])
		]);
		const ancestors = (Array.isArray(anc) ? anc : []).filter(
			(t): t is string => typeof t === 'string' && t !== txid
		);
		const descendants = (Array.isArray(desc) ? desc : []).filter(
			(t): t is string => typeof t === 'string' && t !== txid
		);
		if (ancestors.length === 0 && descendants.length === 0) return null;

		// The mining-relevant rate of this tx's cluster: the higher of its
		// ancestor-package rate (this tx + unconfirmed parents it depends on) and its
		// descendant-package rate (this tx boosted by a fee-paying child). Core fee
		// fields are BTC; sizes are vbytes.
		const ancRate =
			entry.ancestorsize > 0 ? btcToSats(entry.fees.ancestor) / entry.ancestorsize : 0;
		const descRate =
			entry.descendantsize > 0 ? btcToSats(entry.fees.descendant) / entry.descendantsize : 0;
		return {
			effectiveFeeRate: round2(Math.max(ancRate, descRate)),
			ancestors,
			descendants
		};
	}

	/**
	 * Scripthash history with a friendlier error for the one real-world failure
	 * mode: `get_history` on a very active address (an exchange hot wallet) can
	 * exceed an Electrum server's response limit. Surface that as a clear message
	 * the address route already renders, rather than a raw protocol error.
	 */
	private async getScripthashHistory(scripthash: string): Promise<ElectrumHistoryItem[]> {
		try {
			return await this.electrum.getHistory(scripthash);
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			if (/history (too large|exceeds|too long)|too many|excessive|response too large/i.test(msg)) {
				throw new Error(
					'This address has too much history for the Electrum server to return in one response.'
				);
			}
			throw e;
		}
	}

	/**
	 * Balance, tx-count and used-state for any address, via the Electrum scripthash
	 * protocol on the operator's own server (cairn-zoz8.6) instead of a third-party
	 * HTTP explorer API. `get_balance` gives confirmed/unconfirmed; `get_history`'s
	 * length gives the tx count. Lifetime funded/spent sums have NO Electrum
	 * equivalent without walking every historical tx, so totalReceived/totalSent are
	 * null ("unknown") — the Explorer address page hides those stats when null
	 * rather than render a misleading "0 received".
	 */
	async getAddressInfo(address: string): Promise<AddressInfo> {
		const scripthash = addressToScripthash(address);
		const [balance, history] = await Promise.all([
			this.electrum.getBalance(scripthash),
			this.getScripthashHistory(scripthash)
		]);
		const txCount = history.length;
		return {
			address,
			scriptType: detectAddressType(address),
			confirmedBalance: balance.confirmed,
			unconfirmedBalance: balance.unconfirmed,
			txCount,
			totalReceived: null,
			totalSent: null,
			used: txCount > 0
		};
	}

	/**
	 * Transaction history for any address, newest first, ~50 per page, via the
	 * Electrum scripthash protocol (cairn-zoz8.6). `get_history` lists every tx
	 * touching the address (mempool at height ≤ 0); each tx on the requested page is
	 * hydrated with a verbose `blockchain.transaction.get` (plus its prev-txs) to
	 * compute the per-address net delta and the real fee. Electrum doesn't
	 * paginate, so pages are sliced
	 * client-side by `afterTxid` (matching the old ~50-per-page contract).
	 */
	async getAddressTxs(address: string, afterTxid?: string): Promise<AddressTx[]> {
		const PAGE = 50;
		const scripthash = addressToScripthash(address);
		const ourScript = scriptPubKeyHex(address);
		const history = await this.getScripthashHistory(scripthash);

		// Newest first: mempool (height ≤ 0) on top, then confirmed by height desc.
		const ordered = [...history].sort((a, b) => {
			const ha = a.height <= 0 ? Number.MAX_SAFE_INTEGER : a.height;
			const hb = b.height <= 0 ? Number.MAX_SAFE_INTEGER : b.height;
			return hb - ha;
		});

		let startIdx = 0;
		if (afterTxid) {
			const i = ordered.findIndex((h) => h.tx_hash === afterTxid);
			startIdx = i >= 0 ? i + 1 : 0;
		}
		const pageItems = ordered.slice(startIdx, startIdx + PAGE);

		// Fetch each verbose tx once, sharing a cache so a prevout referenced by
		// several inputs (or by both the page and an input) is only fetched a single
		// time. The lookups across the page then run concurrently via Promise.all.
		const txCache = new Map<string, Promise<VerboseTx>>();
		const getVerbose = (txid: string): Promise<VerboseTx> => {
			let p = txCache.get(txid);
			if (!p) {
				p = this.electrum.getTransaction(txid, true) as Promise<VerboseTx>;
				txCache.set(txid, p);
			}
			return p;
		};

		return Promise.all(
			pageItems.map(async (item) => {
				const tx = await getVerbose(item.tx_hash);
				const coinbase = tx.vin.some((v) => typeof v.coinbase === 'string');
				let delta = 0;
				for (const out of tx.vout) {
					if (out.scriptPubKey?.hex === ourScript) delta += btcToSats(out.value);
				}
				// Resolve prevouts to attribute the spent side to this address and to
				// compute the real fee (sum in − sum out). A coinbase has no prevouts
				// and no fee.
				let fee: number | null = item.fee ?? null;
				if (coinbase) {
					fee = null;
				} else {
					const prevs = await Promise.all(
						tx.vin.map((v) => (v.txid ? getVerbose(v.txid) : Promise.resolve(null)))
					);
					let totalIn = 0;
					let feeKnown = true;
					tx.vin.forEach((v, idx) => {
						const prev = prevs[idx];
						const po = prev && v.vout != null ? prev.vout[v.vout] : undefined;
						if (!po) {
							feeKnown = false;
							return;
						}
						totalIn += btcToSats(po.value);
						if (po.scriptPubKey?.hex === ourScript) delta -= btcToSats(po.value);
					});
					if (feeKnown) {
						const totalOut = tx.vout.reduce((s, o) => s + btcToSats(o.value), 0);
						fee = totalIn - totalOut;
					}
				}
				const confirmed = item.height > 0;
				return {
					txid: item.tx_hash,
					height: confirmed ? item.height : 0,
					time: confirmed ? (tx.blocktime ?? tx.time ?? null) : null,
					fee,
					delta
				};
			})
		);
	}

	/**
	 * Current mempool size/backlog. Sourced from the operator's own Bitcoin Core
	 * node (`getmempoolinfo`, cairn-zoz8). Core reports the total fee in BTC —
	 * convert to sats. Throws a clear "needs Core RPC" error when Core isn't
	 * configured, which the mempool route renders as the CoreRpcRequiredNotice
	 * empty-state.
	 */
	async getMempoolSummary(): Promise<MempoolSummary> {
		// 30s TTL-cached (cairn-6efi.1, U3) so the SWR refresh and the mempool
		// sub-pages don't each pay for a fresh getmempoolinfo round-trip.
		return cachedMempoolSummary(async () => {
			if (!this.core) {
				throw new Error(
					'Mempool summary requires a Bitcoin Core RPC connection (configure it in admin settings).'
				);
			}
			const m = await this.core.getMempoolInfo();
			return { txCount: m.size, vsize: m.bytes, totalFees: btcToSats(m.total_fee) };
		});
	}

	/**
	 * Fee-rate distribution of the current mempool; null when unavailable.
	 * Sourced from the operator's own Electrum connection
	 * (`mempool.get_fee_histogram`) rather than a third-party HTTP explorer API
	 * (cairn-zoz8.2). The protocol returns the exact shape this facade exposes —
	 * [feeRate sat/vB, vsize] pairs, highest fee first — so this is a passthrough
	 * that only collapses an empty mempool to null.
	 */
	async getFeeHistogram(): Promise<FeeHistogram | null> {
		// 30s TTL-cached (cairn-6efi.1, U3): mempool sub-pages and the SWR refresh
		// share one histogram round-trip instead of re-fetching it each.
		return cachedFeeHistogram(async () => {
			const histogram = await this.electrum.getFeeHistogram();
			return Array.isArray(histogram) && histogram.length > 0 ? histogram : null;
		});
	}

	/**
	 * Projected next blocks by fee rate; null when no mempool backlog data is
	 * available. Derived from the operator's own Electrum fee histogram
	 * (`mempool.get_fee_histogram`) by greedily packing 1 MvB blocks
	 * (projectBlocksFromHistogram, cairn-zoz8.14) — approximate but fully local, so
	 * it works on an Umbrel-style deploy with no third-party API. Null when the
	 * histogram is empty/unavailable.
	 */
	async getMempoolBlocks(sharedHistogram?: FeeHistogram | null): Promise<MempoolBlockProjection[] | null> {
		// The SWR refresh (chainSync.ts) fetches the histogram ONCE per pass and
		// passes it in here so the projection and the snapshot's own histogram field
		// don't each trigger a fetch (cairn-6efi.1, U3). `undefined` means "no shared
		// value — fetch it myself" (the mempool sub-pages' own callers); an explicit
		// `null` means "already fetched, it was empty" → no projection.
		let hist = sharedHistogram;
		if (hist === undefined) {
			try {
				hist = await this.getFeeHistogram();
			} catch (e) {
				log.debug({ err: e }, 'fee histogram unavailable for mempool-block projection');
				hist = null;
			}
		}
		if (hist && hist.length > 0) return projectBlocksFromHistogram(hist);
		return null;
	}

	/**
	 * Mempool size over the recent past, oldest first; null when no samples exist
	 * yet. Read from a locally-persisted rolling window of samples taken by the
	 * chainSync refresh cycle (mempoolSamples.ts, cairn-zoz8.15) — no third-party
	 * time-series API. The window starts empty after deploy and fills over time, so
	 * the trend chart renders gracefully with sparse (or zero) data.
	 */
	async getMempoolTrend(): Promise<MempoolTrendPoint[] | null> {
		const points = readMempoolTrend(2 * 60 * 60);
		return points.length > 0 ? points : null;
	}

	async getFeeEstimates(): Promise<FeeEstimates> {
		// TTL-cached (30s flat — fee estimates drift continuously) so the send
		// pages and /api/mempool/fees don't each re-fetch the same lookup.
		return cachedFeeEstimates(async () => {
			// Four confirmation targets mapped to the normalized fastest/halfHour/
			// hour/economy shape, sourced from the operator's own Electrum server
			// (`blockchain.estimatefee`) rather than a third-party HTTP explorer API
			// (cairn-zoz8.1). The targets run concurrently.
			const [b1, b3, b6, b144] = await Promise.all([
				this.electrum.estimateFee(1),
				this.electrum.estimateFee(3),
				this.electrum.estimateFee(6),
				this.electrum.estimateFee(144)
			]);
			// estimatefee returns BTC/kvB (or -1 when the server can't estimate that
			// target). Convert to sat/vB: BTC/kvB × 1e8 sat/BTC ÷ 1000 vB/kvB = × 1e5.
			const toSatVb = (btcPerKvb: number): number | null =>
				typeof btcPerKvb === 'number' && btcPerKvb > 0 ? btcPerKvb * 1e5 : null;
			const slots: { key: keyof FeeEstimates; v: number | null }[] = [
				{ key: 'fastest', v: toSatVb(b1) },
				{ key: 'halfHour', v: toSatVb(b3) },
				{ key: 'hour', v: toSatVb(b6) },
				{ key: 'economy', v: toSatVb(b144) }
			];
			// Repair a target the server couldn't estimate (-1) by inheriting the
			// next-LONGER target's rate — walk longest→shortest carrying it forward —
			// then floor everything at 1 sat/vB (the network minimum relay rate).
			let carry = 1;
			for (let i = slots.length - 1; i >= 0; i--) {
				if (slots[i].v === null) slots[i].v = carry;
				else carry = slots[i].v as number;
			}
			const out = {} as FeeEstimates;
			for (const s of slots) out[s.key] = Math.max(1, round2(s.v as number));
			return out;
		});
	}

	/**
	 * Current difficulty-epoch state, derived entirely from block headers on the
	 * operator's own Electrum server (cairn-zoz8.3) — no third-party HTTP explorer
	 * API. The tip header (via headersSubscribe) gives the live difficulty and the
	 * epoch-start header (`blockchain.block.header` at epochStartHeight) gives this
	 * epoch's pace and the retarget projection.
	 */
	async getDifficultyInfo(): Promise<DifficultyInfo> {
		const EPOCH = 2016;
		const TARGET_SECONDS = 600;

		const tipHeader = await this.electrum.headersSubscribe();
		const tip = decodeBlockHeader(tipHeader.hex);
		const tipHeight = tipHeader.height;
		const epochStartHeight = Math.floor(tipHeight / EPOCH) * EPOCH;
		const blocksIntoEpoch = tipHeight - epochStartHeight + 1;
		const nextRetargetHeight = epochStartHeight + EPOCH;

		const base: DifficultyInfo = {
			currentDifficulty: tip.difficulty,
			tipHeight,
			epochStartHeight,
			nextRetargetHeight,
			blocksIntoEpoch,
			blocksRemaining: nextRetargetHeight - tipHeight,
			progressPercent: (blocksIntoEpoch / EPOCH) * 100,
			projectedChangePercent: null,
			previousChangePercent: null,
			avgBlockTimeSeconds: null,
			estimatedRetargetDate: null
		};

		// Measure this epoch's pace directly from its first block's timestamp.
		try {
			const startHex = await this.electrum.getBlockHeader(epochStartHeight);
			const start = decodeBlockHeader(startHex);
			const elapsed = tip.time - start.time;
			const intervals = Math.max(1, tipHeight - epochStartHeight);
			const avg = elapsed / intervals;
			// Retarget multiplier = target/actual pace, clamped to 4x either way
			// (the consensus rule) — expressed here as a percent change.
			const projected = Math.max(-75, Math.min(300, (TARGET_SECONDS / avg - 1) * 100));
			// Clamp the pace used for the date projection to the consensus 4x band
			// (the same bound already applied to projectedChangePercent just above).
			// On a slow test/regtest chain `avg` can balloon to hours, extrapolating
			// an absurd far-future retarget date (observed: year 2255) — cairn-t6t7.
			// The displayed avgBlockTimeSeconds stays the true measured value.
			const projectionAvg = Math.max(TARGET_SECONDS / 4, Math.min(TARGET_SECONDS * 4, avg));
			return {
				...base,
				avgBlockTimeSeconds: avg,
				projectedChangePercent: projected,
				estimatedRetargetDate: tip.time + base.blocksRemaining * projectionAvg
			};
		} catch (e) {
			log.debug({ err: e }, 'epoch-pace difficulty projection failed; returning base info');
			return base;
		}
	}

	/**
	 * Recent difficulty retargets, oldest first; null when unavailable. Reads the
	 * header at each epoch-boundary height (`blockchain.block.header`, run
	 * concurrently) from the operator's own Electrum server and decodes each one's
	 * difficulty — no third-party HTTP explorer API (cairn-zoz8.3). changePercent is
	 * computed between consecutive epochs here. The header at an epoch-start height
	 * carries that epoch's `nBits`, so its decoded difficulty IS that retarget.
	 */
	async getDifficultyHistory(limit = 10): Promise<DifficultyAdjustment[] | null> {
		const EPOCH = 2016;
		try {
			const tipHeader = await this.electrum.headersSubscribe();
			const latestEpochStart = Math.floor(tipHeader.height / EPOCH) * EPOCH;
			// Epoch-boundary heights that exist on-chain, oldest first (so each
			// changePercent compares against the prior epoch).
			const heights: number[] = [];
			for (let i = 0; i < limit; i++) {
				const h = latestEpochStart - i * EPOCH;
				if (h < 0) break;
				heights.push(h);
			}
			heights.reverse();
			if (heights.length === 0) return null;
			const headers = await Promise.all(heights.map((h) => this.electrum.getBlockHeader(h)));
			const decoded = headers.map((hex) => decodeBlockHeader(hex));
			return decoded.map((d, i) => {
				const prev = i > 0 ? decoded[i - 1].difficulty : null;
				return {
					time: d.time,
					height: heights[i],
					difficulty: d.difficulty,
					changePercent: prev ? ((d.difficulty - prev) / prev) * 100 : null
				};
			});
		} catch (e) {
			log.debug({ err: e }, 'difficulty history via electrum failed');
			return null;
		}
	}

	/**
	 * Network hashrate in H/s, always derived from the tip block's difficulty
	 * (`difficulty × 2^32 / 600`). The Electrum protocol has no direct hashrate
	 * call, so this difficulty-derived estimate is the only one (cairn-zoz8.3).
	 * Null only when the tip header can't be
	 * fetched/decoded.
	 */
	async getHashrate(): Promise<number | null> {
		try {
			const tipHeader = await this.electrum.headersSubscribe();
			const { difficulty } = decodeBlockHeader(tipHeader.hex);
			return (difficulty * 2 ** 32) / 600;
		} catch (e) {
			log.debug({ err: e }, 'hashrate (difficulty-derived) failed');
			return null;
		}
	}

	/**
	 * BTC→USD spot for the opt-in fiat estimate. Neither Electrum nor Bitcoin Core
	 * RPC exposes a spot price, so this reaches the single permitted public source
	 * (mempool.space /v1/prices) — the one remaining external call in the chain
	 * layer (cairn-zoz8.18). TTL-cached with a short timeout so it can never gate a
	 * page render, and only fires when a caller actually asks for a fiat value.
	 */
	async getBtcUsdPrice(): Promise<number | null> {
		return fetchPublicBtcUsdPrice();
	}

	/**
	 * Block timestamp (unix seconds) at a given height, from the operator's own
	 * Electrum server (`blockchain.block.header` → decode). Backend-agnostic seam
	 * used by chainEpochs.ts for boundary timestamps (cairn-zoz8) — works with zero
	 * third-party API.
	 */
	async getBlockTimeAtHeight(height: number): Promise<number> {
		const hex = await this.electrum.getBlockHeader(height);
		return decodeBlockHeader(hex).time;
	}

	async getNodeInfo(): Promise<NodeInfo> {
		const server = this.electrum.server;
		try {
			const header = await this.electrum.headersSubscribe();
			let banner: string | undefined;
			try {
				banner = await this.electrum.banner();
			} catch {
				banner = undefined;
			}
			let tipHash: string | null = null;
			try {
				tipHash = blockHashFromHeader(header.hex);
			} catch {
				tipHash = null;
			}
			return {
				connected: true,
				mode: this.config.mode,
				server,
				serverBanner: banner,
				tipHeight: header.height,
				tipHash,
				network: 'mainnet'
			};
		} catch (e) {
			return {
				connected: false,
				mode: this.config.mode,
				server,
				tipHeight: null,
				tipHash: null,
				network: 'mainnet',
				error: e instanceof Error ? e.message : String(e)
			};
		}
	}

	// ------------------------------------------------------- electrum passthroughs

	scripthashBalance(sh: string): Promise<ElectrumBalance> {
		return this.electrum.getBalance(sh);
	}

	scripthashHistory(sh: string): Promise<ElectrumHistoryItem[]> {
		return this.electrum.getHistory(sh);
	}
}

// ------------------------------------------------------------------- singleton

let instance: ChainService | null = null;

/** Lazy process-wide ChainService built from the current admin settings. */
export function getChain(): ChainService {
	if (!instance) instance = new ChainService();
	return instance;
}

/**
 * Re-read config and swap in fresh Electrum + Bitcoin Core RPC instances.
 * Called after the admin saves connection settings — no restart needed.
 */
export function reconfigureChain(): void {
	const old = instance;
	const oldServer = old?.electrum.server ?? null;
	instance = null;
	old?.close();

	// Report the switch on the activity feed. close() tears the old client down
	// without emitting 'disconnect', so reset the connection dedupe too — the
	// next client's first connect should register as a fresh network_up.
	const cfg = getChainConfig();
	const newServer = `${cfg.electrumHost}:${cfg.electrumPort}`;
	if (oldServer && oldServer !== newServer) {
		recordActivity({
			type: 'electrum_switched',
			message: `Electrum server switched from ${oldServer} to ${newServer}`,
			detail: { from: oldServer, to: newServer }
		});
	}
	resetConnectionState();
	// Forget accumulated transport-health failures so the new server/proxy starts
	// from a clean slate — a stale error from the old backend must not linger on
	// the chain-health banner (cairn-hy8z). The next ChainService (built lazily by
	// getChain) re-notes whether a proxy is configured in its constructor.
	resetChainHealth();
	// The Core-scoped signal is per-backend too — a stale Core failure/success from
	// the old endpoint must not leak into the new one's NodeTrust claim (cairn-7qmw).
	resetCoreHealth();
	// Package-relay support is per-server — forget the cached verdict so the new
	// backend is probed afresh (cairn-u9ob.8).
	resetPackageRelaySupport();
	// Tip + fee-estimate TTL caches are per-backend too — clear them so a server
	// switch never serves a value fetched from the old backend (cairn-vknb.5).
	resetChainCaches();
}

// ---------------------------------------------------------------- test helpers

export async function testElectrum(cfg: {
	host: string;
	port: number;
	tls: boolean;
	tlsInsecure?: boolean;
	socks5Host?: string | null;
	socks5Port?: number | null;
}): Promise<{ ok: boolean; banner?: string; tipHeight?: number; error?: string }> {
	const client = new ElectrumClient({ ...cfg, timeoutMs: 8_000 });
	try {
		const header = await client.headersSubscribe();
		let banner: string | undefined;
		try {
			banner = await client.banner();
		} catch {
			banner = undefined;
		}
		return { ok: true, banner, tipHeight: header.height };
	} catch (e) {
		return { ok: false, error: e instanceof Error ? e.message : String(e) };
	} finally {
		client.close();
	}
}

/**
 * Wrap a Bitcoin Core RPC test-connection failure in the house "what happened
 * + what to do" copy (UX-PLAN §5.1) instead of surfacing Core's raw
 * transport/auth exception text as the only thing the admin sees
 * (qa-findings-R8.md X3: a bogus RPC URL returned a bare "Core RPC
 * getblockchaininfo request failed: fetch failed: connect ECONNREFUSED ..."
 * string). The raw detail is kept verbatim — an operator may recognize
 * node-specific phrasing a generic hint doesn't cover — it's just never the
 * ONLY sentence shown, matching broadcastRejection.ts's friendlyBroadcastRejection.
 */
function friendlyCoreRpcTestError(raw: string): string {
	const lower = raw.toLowerCase();
	// Timeout / abort — the 8s AbortController fired. Node surfaces this as
	// "This operation was aborted (20)" / AbortError, which means nothing to an
	// operator (cairn-i9u6). It's a no-response, never a config typo.
	if (
		lower.includes('aborted') ||
		lower.includes('aborterror') ||
		lower.includes('timed out') ||
		lower.includes('timeout')
	) {
		return 'No response from the node after 8 seconds — check the address and that the node is reachable from this server.';
	}
	// HTTP 403 from bitcoind almost always means this host's IP isn't in the node's
	// rpcallowip allowlist, NOT a credential problem — the generic "check
	// username/password" hint misdirects (cairn-ymcg).
	if (/\bhttp 403\b/.test(lower)) {
		return "The node refused this connection (HTTP 403) — your server's IP address is probably not in the node's rpcallowip allowlist.";
	}
	// Otherwise keep the raw detail (an operator may recognize node-specific
	// phrasing a generic hint doesn't cover), but trim any trailing punctuation so
	// an empty/edge detail never renders dangling "…: ." artifacts (cairn-ymcg).
	const detail = raw.replace(/[\s.:]+$/, '');
	return `Couldn't connect to Bitcoin Core: ${detail}. Check the RPC URL, username/password, and that Core is running and reachable from this server.`;
}

/**
 * Validate a Bitcoin Core RPC URL BEFORE any fetch touches it. A relative string
 * like `not-a-url` makes SvelteKit's global fetch throw a framework-internal
 * "Cannot use relative URL … use event.fetch" error, and a non-http scheme
 * (`ftp://…`) fails with an opaque "unknown scheme" — both leaked verbatim to the
 * admin (cairn-mf9i). Catch them here with plain operator copy. Returns an error
 * string when invalid, or null when the URL is an absolute http(s):// endpoint.
 */
export function coreRpcUrlError(url: string): string | null {
	const invalid =
		"That doesn't look like a valid URL — enter something like http://192.168.1.10:8332";
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return invalid;
	}
	if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return invalid;
	return null;
}

/**
 * Probe a Bitcoin Core RPC endpoint for the admin settings "Test connection"
 * button: ping() first (a never-throwing liveness+auth check), then
 * getBlockchainInfo() for the chain name and authoritative tip height. Any
 * failure is translated to `{ ok: false, error }` so the settings UI can render
 * a badge without try/catch of its own — same contract as testElectrum.
 */
export async function testCoreRpc(cfg: {
	url: string;
	user?: string | null;
	pass?: string | null;
}): Promise<{ ok: boolean; blockHeight?: number; chain?: string; error?: string }> {
	// Reject an invalid/relative URL up front, before it reaches global fetch and
	// throws a SvelteKit-internal error the admin can't parse (cairn-mf9i).
	const urlError = coreRpcUrlError(cfg.url);
	if (urlError) return { ok: false, error: urlError };
	// The CoreRpcClient is a normal static import (top of file), matching
	// testElectrum. Any real connection/auth failure still degrades to the
	// `{ ok: false, error }` shape the settings UI renders.
	try {
		const client = new CoreRpcClient({
			url: cfg.url,
			user: cfg.user,
			pass: cfg.pass,
			timeoutMs: 8_000
		});
		try {
			const pong = await client.ping();
			if (!pong.ok) {
				return {
					ok: false,
					error: pong.error
						? friendlyCoreRpcTestError(pong.error)
						: "Bitcoin Core didn't respond to a ping. Check the RPC URL, username/password, and that Core is running and reachable from this server."
				};
			}
			const info = await client.getBlockchainInfo();
			return { ok: true, blockHeight: info.blocks, chain: info.chain };
		} finally {
			client.close();
		}
	} catch (e) {
		const raw = e instanceof Error ? e.message : String(e);
		return { ok: false, error: friendlyCoreRpcTestError(raw) };
	}
}
