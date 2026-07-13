// ChainService: the facade routes and features import for all chain data.
// Tip, recent blocks, fee estimates, difficulty/hashrate, arbitrary address
// lookups, node liveness and wallet balances+history all come from the operator's
// own Electrum protocol server. The explorer-rich views (full block/tx detail,
// mempool summary/projections, CPFP) come from the operator's own Bitcoin Core
// node over JSON-RPC (Esplora-removal Wave 2, cairn-zoz8.10/.11/.12/.14). An
// Esplora-compatible HTTP API is kept ONLY as an optional last-resort fallback
// for operators who explicitly configured an esploraUrl — when none is set it is
// never constructed and never dialed, so an Umbrel-style deploy (local Core RPC +
// electrs, no route to the public internet) is fully functional and pays no
// third-party timeout penalty.

import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { getChainConfig } from '../settings';
import { ElectrumClient } from '../electrum/client';
import { ElectrumPool } from '../electrum/pool';
import type { ElectrumBalance, ElectrumHistoryItem } from '../electrum/client';
import { addressToScripthash, scriptPubKeyHex } from '../bitcoin/xpub';
import { wireChainEvents, resetConnectionState } from '../chainEvents';
import { noteProxyConfigured, resetChainHealth } from '../chainHealth';
import { resetPackageRelaySupport } from '../packageRelay';
import { recordActivity } from '../activity';
import { childLogger } from '../logger';
import { EsploraApi } from './esplora';
import { CoreRpcClient, CoreRpcError } from '../bitcoinCore/client';
import { readMempoolTrend } from '../mempoolSamples';
import {
	cachedTip,
	cachedFeeEstimates,
	resetChainCaches,
	getCachedRawTx,
	cacheRawTx,
	getCachedBlockStats,
	cacheBlockStats
} from './cache';
import type { EsploraBlock, EsploraTx } from './esplora';
import type {
	AddressInfo,
	AddressTx,
	BlockDetail,
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

// Public price fallback for plain esplora backends (blockstream.info) that have
// no /v1/prices endpoint of their own. Cached process-wide (independent of the
// configured backend, so it survives a chain reconfigure) to avoid hammering
// the public source. A v1-capable backend never reaches this — it serves its
// own prices — so a self-hoster with their own mempool instance is never
// silently redirected to the public internet.
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

/** Loose shape of one node in mempool.space's RBF replacement tree. */
interface RbfTreeNode {
	tx?: { txid?: string };
	time?: number;
	fullRbf?: boolean;
	replaces?: RbfTreeNode[];
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

function toBlockSummary(b: EsploraBlock): BlockSummary {
	const fr = b.extras?.feeRange;
	return {
		height: b.height,
		hash: b.id,
		time: b.timestamp,
		txCount: b.tx_count,
		size: b.size,
		weight: b.weight,
		medianFee: typeof b.extras?.medianFee === 'number' ? round2(b.extras.medianFee) : null,
		feeRange:
			Array.isArray(fr) && fr.length >= 2 ? [round2(fr[0]), round2(fr[fr.length - 1])] : null,
		// Esplora block summaries don't carry a total-output aggregate; leave it
		// null (Cardinal rule) — fullness is still derivable from the weight.
		total_out: null,
		fullness: fullnessFromWeight(typeof b.weight === 'number' ? b.weight : null),
		miner: b.extras?.pool?.name
	};
}

function toTxDetail(tx: EsploraTx, tipHeight: number, outspends?: (boolean | null)[]): TxDetail {
	const confirmed = tx.status.confirmed;
	const blockHeight = confirmed ? (tx.status.block_height ?? null) : null;
	const vsize = Math.ceil(tx.weight / 4);
	const coinbase = tx.vin.some((v) => v.is_coinbase);
	const fee = coinbase ? null : (tx.fee ?? null);

	const vin: TxVin[] = tx.vin.map((v) =>
		v.is_coinbase
			? {
					txid: null,
					vout: null,
					address: null,
					value: null,
					prevScriptPubKey: null,
					coinbase: true,
					scriptSig: v.scriptsig || null,
					witness: v.witness?.length ? v.witness : null
				}
			: {
					txid: v.txid,
					vout: v.vout,
					address: v.prevout?.scriptpubkey_address ?? null,
					value: v.prevout?.value ?? null,
					prevScriptPubKey: v.prevout?.scriptpubkey ?? null,
					coinbase: false,
					scriptSig: v.scriptsig || null,
					witness: v.witness?.length ? v.witness : null
				}
	);
	const vout: TxVout[] = tx.vout.map((v, i) => ({
		address: v.scriptpubkey_address ?? null,
		value: v.value,
		scriptType: v.scriptpubkey_type,
		scriptPubKey: v.scriptpubkey,
		spent: outspends?.[i] ?? null
	}));

	// SegWit moves signatures out of the base serialization, so weight < size*4.
	const segwit = tx.weight < tx.size * 4 || tx.vin.some((v) => (v.witness?.length ?? 0) > 0);
	// BIP125: any input with sequence below 0xfffffffe opts in to replacement.
	const rbf = !coinbase && tx.vin.some((v) => (v.sequence ?? 0xffffffff) < 0xfffffffe);

	return {
		txid: tx.txid,
		confirmed,
		blockHeight,
		blockHash: confirmed ? (tx.status.block_hash ?? null) : null,
		blockTime: confirmed ? (tx.status.block_time ?? null) : null,
		confirmations: confirmed && blockHeight !== null ? Math.max(0, tipHeight - blockHeight + 1) : 0,
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
	 * Optional last-resort Esplora backend — constructed ONLY when the operator
	 * explicitly configured an esploraUrl (public mode, or a custom esplora_url).
	 * Null on an Umbrel-style local-only deploy, so no chain method ever dials
	 * (and pays a 12s timeout against) a third-party HTTP API that isn't there.
	 */
	readonly esplora: EsploraApi | null;
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
		this.esplora = config.esploraUrl
			? new EsploraApi(config.esploraUrl, {
					socks5Host: config.socks5Host,
					socks5Port: config.socks5Port
				})
			: null;
		this.core = config.coreRpcUrl
			? new CoreRpcClient({
					url: config.coreRpcUrl,
					user: config.coreRpcUser,
					pass: config.coreRpcPass,
					socks5Host: config.socks5Host,
					socks5Port: config.socks5Port
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
			// getNodeInfo already uses — no third-party esplora HTTP call (cairn-zoz8.5).
			const header = await this.electrum.headersSubscribe();
			return { height: header.height, hash: blockHashFromHeader(header.hex) };
		});
	}

	/**
	 * Recent blocks, newest first. The baseline comes from the operator's own
	 * Electrum server (`blockchain.block.header` per height, fetched concurrently)
	 * instead of a third-party esplora HTTP API (cairn-zoz8.5). A raw 80-byte header
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
				try {
					const stats = await this.getRecentBlockStats(core, row.hash);
					if (stats) applyBlockStats(row, stats);
				} catch (e) {
					// Pruned node / disabled getblockstats / transient RPC error: leave
					// this row at its null baseline rather than failing the whole list.
					log.debug({ err: e, height: row.height }, 'getblockstats enrichment failed; row stays null');
				}
			});
		}
		return rows;
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
	 * stats), falling back to an explicitly-configured Esplora backend, and finally
	 * throwing a clear "needs Core RPC" error the block route renders as the
	 * CoreRpcRequiredNotice empty-state (cairn-zoz8.10). Throws a not-found error
	 * for an unknown hash/height so the search classifier can fall through.
	 */
	async getBlock(hashOrHeight: string | number): Promise<BlockDetail> {
		if (this.core) {
			try {
				return await this.getBlockViaCore(this.core, hashOrHeight);
			} catch (e) {
				if (e instanceof CoreRpcError && (e.code === -5 || e.code === -8)) {
					throw new Error(`Block not found: ${hashOrHeight}`);
				}
				if (!this.esplora) throw e;
				log.debug({ err: e }, 'Core getBlock failed; falling back to esplora');
			}
		}
		if (this.esplora) return this.getBlockViaEsplora(this.esplora, hashOrHeight);
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

	private async getBlockViaEsplora(
		esplora: EsploraApi,
		hashOrHeight: string | number
	): Promise<BlockDetail> {
		let hash: string;
		if (typeof hashOrHeight === 'number' || /^\d{1,7}$/.test(String(hashOrHeight))) {
			hash = await esplora.getBlockHashAtHeight(Number(hashOrHeight));
		} else {
			hash = String(hashOrHeight);
		}
		const block = await esplora.getBlockByHash(hash);

		// mempool.space extras (fees, miner) live on the /v1/blocks summaries.
		let extras: EsploraBlock['extras'];
		try {
			const summaries = await esplora.getBlocks(block.height);
			extras = summaries.find((b) => b.id === block.id)?.extras;
		} catch (e) {
			log.debug({ err: e, height: block.height }, 'block extras (fees/miner) unavailable');
			extras = undefined;
		}

		const summary = toBlockSummary({ ...block, extras });
		return {
			...summary,
			prevHash: block.previousblockhash ?? null,
			merkleRoot: block.merkle_root,
			nonce: block.nonce,
			bits: block.bits.toString(16),
			difficulty: block.difficulty,
			version: block.version,
			totalFees: typeof extras?.totalFees === 'number' ? extras.totalFees : null,
			reward: typeof extras?.reward === 'number' ? extras.reward : null
		};
	}

	/** Transactions of a block, 25 per page (page is 0-based). */
	async getBlockTxs(hash: string, page = 0): Promise<{ txs: TxDetail[]; total: number }> {
		if (this.core) {
			try {
				return await this.getBlockTxsViaCore(this.core, hash, page);
			} catch (e) {
				if (!this.esplora) throw e;
				log.debug({ err: e, hash }, 'Core getBlockTxs failed; falling back to esplora');
			}
		}
		if (this.esplora) {
			const esplora = this.esplora;
			const [block, rawTxs, tipHeight] = await Promise.all([
				esplora.getBlockByHash(hash),
				esplora.getBlockTxs(hash, page * BLOCK_TXS_PAGE_SIZE),
				esplora.getTipHeight()
			]);
			return {
				txs: rawTxs.map((tx) => toTxDetail(tx, tipHeight)),
				total: block.tx_count
			};
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
	 * addresses are exact — plus per-output `gettxout` for spent-ness), falling back
	 * to an explicitly-configured Esplora backend. Throws a not-found error for an
	 * unknown txid so the search classifier and tx route can handle it.
	 */
	async getTx(txid: string): Promise<TxDetail> {
		if (this.core) {
			try {
				return await this.getTxViaCore(this.core, txid);
			} catch (e) {
				if (e instanceof CoreRpcError && (e.code === -5 || e.code === -8)) {
					// -5/-8 here is ambiguous: it's Core's code for BOTH "genuinely no such
					// tx" and "this tx isn't in the mempool/wallet and Core has no -txindex
					// to look up an arbitrary confirmed one" (the exact scenario an
					// explicitly-configured Esplora fallback exists to cover — an indexed
					// Esplora/electrs backend can serve it even when Core can't). Try that
					// fallback before declaring not-found; only give up as not-found if
					// Esplora also misses (or there is none configured).
					if (this.esplora) {
						try {
							return await this.getTxViaEsplora(this.esplora, txid);
						} catch (e2) {
							log.debug(
								{ err: e2, txid },
								'esplora fallback also failed after Core -5/-8; reporting not-found'
							);
						}
					}
					throw new Error(`Transaction not found: ${txid}`);
				}
				if (!this.esplora) throw e;
				log.debug({ err: e, txid }, 'Core getTx failed; falling back to esplora');
			}
		}
		if (this.esplora) return this.getTxViaEsplora(this.esplora, txid);
		throw new Error(
			'Transaction detail requires a Bitcoin Core RPC connection (configure it in admin settings).'
		);
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

	private async getTxViaEsplora(esplora: EsploraApi, txid: string): Promise<TxDetail> {
		// All three fetches ride the same round trip. Output spent-ness is a
		// nice-to-have, so its promise carries its own catch — it resolves to
		// `undefined` on failure rather than rejecting the whole Promise.all, which
		// preserves the degrade-to-null behavior while keeping the fetch concurrent
		// with tx/tipHeight instead of a second sequential trip (cairn-daej).
		const [tx, tipHeight, outspends] = await Promise.all([
			esplora.getTx(txid),
			esplora.getTipHeight(),
			esplora
				.getTxOutspends(txid)
				.then((os): (boolean | null)[] | undefined => os.map((o) => o.spent ?? null))
				.catch((e) => {
					log.debug({ err: e, txid }, 'outspends unavailable; output spent-ness degraded to null');
					return undefined;
				})
		]);
		return toTxDetail(tx, tipHeight, outspends);
	}

	/**
	 * Raw serialization of a transaction, hex.
	 *
	 * Sourced from the operator's own Electrum server via
	 * `blockchain.transaction.get(txid, verbose=false)` rather than a third-party
	 * esplora HTTP API (cairn-zoz8.4) — a full-indexing Electrum backend
	 * (ElectrumX/Fulcrum/electrs) returns the raw hex for any confirmed or mempool
	 * txid, not just wallet-owned ones. Throws when the server can't produce the
	 * hex (tx not found, or a non-indexing server), matching the previous
	 * esplora-backed contract so callers' existing try/catch handling is unchanged.
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
	 * Replace-by-fee timeline for a transaction, oldest version first.
	 * Null when the backend has no RBF index or the tx was never replaced.
	 *
	 * Bitcoin Core exposes no HISTORICAL replacement lineage (only whether a live
	 * mempool tx is bip125-replaceable, which TxDetail.rbf already carries from the
	 * input sequences). A real replacement chain needs a forward-looking watcher
	 * that records old→new txids as they happen (cairn-zoz8.13, deferred) — until
	 * then this is available only from an explicitly-configured Esplora backend and
	 * degrades to null otherwise. The tx page's RBF section is already gated on a
	 * null result, so this degrades cleanly.
	 */
	async getTxRbfInfo(txid: string): Promise<RbfInfo | null> {
		if (!this.esplora) return null;
		const raw = (await this.esplora.getTxRbf(txid)) as {
			replacements?: RbfTreeNode | null;
			replaces?: unknown[];
		} | null;
		if (!raw) return null;

		const root = raw.replacements;
		if (!root || typeof root !== 'object' || !root.tx?.txid) {
			return null;
		}

		// The tree's root is the newest version; each node's `replaces` holds
		// what it displaced. Multiple branches are possible (a replacement can
		// evict several conflicting txs) — follow the branch containing the
		// queried tx when there is one, else the first.
		const chain: RbfInfo['chain'] = [];
		let node: RbfTreeNode | undefined = root;
		let fullRbf = false;
		while (node && node.tx?.txid && chain.length < 25) {
			chain.push({ txid: node.tx.txid, time: typeof node.time === 'number' ? node.time : null });
			if (node.fullRbf) fullRbf = true;
			const next: RbfTreeNode[] = Array.isArray(node.replaces) ? node.replaces : [];
			node = next.find((n) => n.tx?.txid === txid) ?? next[0];
		}
		if (chain.length < 2) return null; // no actual replacement happened
		chain.reverse(); // oldest first
		return { chain, fullRbf };
	}

	/**
	 * CPFP package context for an unconfirmed tx; null when not applicable.
	 * Sourced from the operator's own Bitcoin Core mempool
	 * (`getmempoolentry` + `getmempoolancestors`/`getmempooldescendants`,
	 * cairn-zoz8.12), falling back to an explicitly-configured Esplora backend.
	 * A confirmed/unknown tx (not in the mempool) yields null.
	 */
	async getCpfpInfo(txid: string): Promise<CpfpInfo | null> {
		if (this.core) {
			try {
				return await this.getCpfpViaCore(this.core, txid);
			} catch (e) {
				// -5 (not in mempool) is the normal confirmed/unknown case → no CPFP.
				if (e instanceof CoreRpcError && (e.code === -5 || e.code === -8)) return null;
				if (!this.esplora) {
					log.debug({ err: e, txid }, 'core CPFP lookup failed; no CPFP context');
					return null;
				}
				log.debug({ err: e, txid }, 'core CPFP lookup failed; trying esplora');
			}
		}
		if (this.esplora) return this.getCpfpViaEsplora(this.esplora, txid);
		return null;
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

	private async getCpfpViaEsplora(esplora: EsploraApi, txid: string): Promise<CpfpInfo | null> {
		const raw = (await esplora.getCpfp(txid)) as {
			ancestors?: { txid?: string }[];
			descendants?: { txid?: string }[];
			bestDescendant?: { txid?: string } | null;
			effectiveFeePerVsize?: number;
		} | null;
		if (!raw || typeof raw.effectiveFeePerVsize !== 'number') return null;

		const ancestors = (raw.ancestors ?? [])
			.map((a) => a.txid)
			.filter((t): t is string => typeof t === 'string');
		const descendants = [...(raw.descendants ?? []), raw.bestDescendant ?? undefined]
			.map((d) => d?.txid)
			.filter((t): t is string => typeof t === 'string');
		if (ancestors.length === 0 && descendants.length === 0) return null;

		return {
			effectiveFeeRate: round2(raw.effectiveFeePerVsize),
			ancestors,
			descendants: [...new Set(descendants)]
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
	 * esplora HTTP API. `get_balance` gives confirmed/unconfirmed; `get_history`'s
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
	 * compute the per-address net delta and the real fee — the same numbers the old
	 * esplora path returned. Electrum doesn't paginate, so pages are sliced
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
	 * node (`getmempoolinfo`, cairn-zoz8), falling back to an explicitly-configured
	 * Esplora backend. Core reports the total fee in BTC — convert to sats.
	 */
	async getMempoolSummary(): Promise<MempoolSummary> {
		if (this.core) {
			try {
				const m = await this.core.getMempoolInfo();
				return { txCount: m.size, vsize: m.bytes, totalFees: btcToSats(m.total_fee) };
			} catch (e) {
				if (!this.esplora) throw e;
				log.debug({ err: e }, 'Core getmempoolinfo failed; falling back to esplora');
			}
		}
		if (this.esplora) {
			const m = await this.esplora.getMempool();
			return { txCount: m.count, vsize: m.vsize, totalFees: m.total_fee };
		}
		throw new Error(
			'Mempool summary requires a Bitcoin Core RPC connection (configure it in admin settings).'
		);
	}

	/**
	 * Fee-rate distribution of the current mempool; null when unavailable.
	 * Sourced from the operator's own Electrum connection
	 * (`mempool.get_fee_histogram`) rather than a third-party esplora HTTP API
	 * (cairn-zoz8.2). The protocol returns the exact shape this facade exposes —
	 * [feeRate sat/vB, vsize] pairs, highest fee first — so this is a passthrough
	 * that only collapses an empty mempool to null.
	 */
	async getFeeHistogram(): Promise<FeeHistogram | null> {
		const histogram = await this.electrum.getFeeHistogram();
		return Array.isArray(histogram) && histogram.length > 0 ? histogram : null;
	}

	/**
	 * Projected next blocks by fee rate; null when no mempool backlog data is
	 * available. Derived from the operator's own Electrum fee histogram
	 * (`mempool.get_fee_histogram`) by greedily packing 1 MvB blocks
	 * (projectBlocksFromHistogram, cairn-zoz8.14) — approximate but fully local, so
	 * it works on an Umbrel-style deploy with no third-party API. Falls back to an
	 * explicitly-configured Esplora backend's own projection when the histogram is
	 * empty/unavailable.
	 */
	async getMempoolBlocks(): Promise<MempoolBlockProjection[] | null> {
		let hist: FeeHistogram | null = null;
		try {
			hist = await this.getFeeHistogram();
		} catch (e) {
			log.debug({ err: e }, 'fee histogram unavailable for mempool-block projection');
		}
		if (hist && hist.length > 0) return projectBlocksFromHistogram(hist);

		if (this.esplora) {
			const blocks = await this.esplora.getMempoolBlocks();
			if (!blocks) return null;
			return blocks.map((b) => ({
				nTx: b.nTx,
				vsize: b.blockVSize,
				totalFees: b.totalFees,
				medianFee: round2(b.medianFee),
				feeRange:
					b.feeRange.length >= 2
						? [round2(b.feeRange[0]), round2(b.feeRange[b.feeRange.length - 1])]
						: [round2(b.medianFee), round2(b.medianFee)]
			}));
		}
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
			// (`blockchain.estimatefee`) rather than a third-party esplora HTTP API
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
	 * operator's own Electrum server (cairn-zoz8.3) — no third-party esplora HTTP
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
	 * difficulty — no third-party esplora HTTP API (cairn-zoz8.3). changePercent is
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
	 * call, so — unlike the old esplora path — this difficulty-derived estimate is
	 * the only one (cairn-zoz8.3). Null only when the tip header can't be
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
	 * BTC→USD spot for the opt-in fiat estimate. Prefers the admin's own
	 * configured backend when it serves prices (a self-hosted mempool instance),
	 * so a sovereignty-minded operator who pointed Cairn at their own node never
	 * quietly leaks to the public internet. Only a plain esplora backend
	 * (blockstream.info) — which has no price endpoint at all — falls back to the
	 * public mempool.space; a v1-capable backend that merely fails is reported as
	 * unavailable rather than silently bypassed.
	 */
	async getBtcUsdPrice(): Promise<number | null> {
		// An explicitly-configured Esplora backend that serves its own /v1/prices
		// (a self-hosted mempool instance) is preferred so a sovereignty-minded
		// operator never quietly leaks to the public internet. Otherwise — including
		// an Umbrel-style deploy with no Esplora at all — fall back to the single
		// permitted public source, which is TTL-cached and short-timeout so it can
		// never gate a page render (cairn-zoz8.18).
		if (this.esplora && (await this.esplora.supportsV1())) {
			return this.esplora.getBtcUsdPrice();
		}
		return fetchPublicBtcUsdPrice();
	}

	/**
	 * Block timestamp (unix seconds) at a given height, from the operator's own
	 * Electrum server (`blockchain.block.header` → decode). Backend-agnostic seam
	 * for callers that used to reach into `chain.esplora` directly for boundary
	 * timestamps (chainEpochs.ts, cairn-zoz8) — works with zero third-party API.
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
 * Re-read config and swap in fresh Electrum/Esplora instances.
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

export async function testEsplora(
	url: string,
	proxy?: { socks5Host?: string | null; socks5Port?: number | null }
): Promise<{ ok: boolean; tipHeight?: number; error?: string }> {
	try {
		const api = new EsploraApi(url, proxy);
		const tipHeight = await api.getTipHeight();
		if (!Number.isFinite(tipHeight)) {
			return { ok: false, error: 'Server did not return a numeric tip height' };
		}
		return { ok: true, tipHeight };
	} catch (e) {
		return { ok: false, error: e instanceof Error ? e.message : String(e) };
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
	return `Couldn't connect to Bitcoin Core: ${raw}. Check the RPC URL, username/password, and that Core is running and reachable from this server.`;
}

/**
 * Probe a Bitcoin Core RPC endpoint for the admin settings "Test connection"
 * button: ping() first (a never-throwing liveness+auth check), then
 * getBlockchainInfo() for the chain name and authoritative tip height. Any
 * failure is translated to `{ ok: false, error }` so the settings UI can render
 * a badge without try/catch of its own — same contract as testElectrum/testEsplora.
 */
export async function testCoreRpc(cfg: {
	url: string;
	user?: string | null;
	pass?: string | null;
}): Promise<{ ok: boolean; blockHeight?: number; chain?: string; error?: string }> {
	// The CoreRpcClient is now a normal static import (top of file), matching
	// testElectrum/testEsplora — Wave 1's dynamic-import workaround for a
	// not-yet-merged module is no longer needed. Any real connection/auth failure
	// still degrades to the `{ ok: false, error }` shape the settings UI renders.
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
