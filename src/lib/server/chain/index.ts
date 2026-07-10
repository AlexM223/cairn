// ChainService: the facade routes and features import for all chain data.
// Tip, recent blocks, fee estimates, difficulty/hashrate, arbitrary address
// lookups, node liveness and wallet balances+history all come from the operator's
// own Electrum protocol server; the remaining explorer-rich views (full block/tx
// detail, mempool projections, RBF/CPFP, prices) still use an esplora-compatible
// HTTP API until their own migrations land.

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
import { cachedTip, cachedFeeEstimates, resetChainCaches } from './cache';
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

// ------------------------------------------------------------------ ChainService

export class ChainService {
	// A pool of Electrum connections behind one ElectrumClient-shaped facade, so
	// concurrent lookups fan out across sockets instead of queuing on one
	// (cairn-ynfp). Subscriptions stay on the pool's primary connection; every
	// call site is unaware it's pooled.
	readonly electrum: ElectrumPool;
	readonly esplora: EsploraApi;
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
		this.esplora = new EsploraApi(config.esploraUrl, {
			socks5Host: config.socks5Host,
			socks5Port: config.socks5Port
		});
	}

	close(): void {
		this.electrum.close();
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
	 * Recent blocks, newest first, from the operator's own Electrum server
	 * (`blockchain.block.header` per height, fetched concurrently) instead of a
	 * third-party esplora HTTP API (cairn-zoz8.5). A raw 80-byte header carries only
	 * version/prevhash/merkleroot/time/bits/nonce — NOT tx_count/size/weight or fee
	 * stats — so those fields are 0/null in this Electrum-only baseline; a later bead
	 * (cairn-zoz8.10) enriches them via Bitcoin Core RPC when configured.
	 */
	async getRecentBlocks(limit = 10, fromHeight?: number): Promise<BlockSummary[]> {
		const top = fromHeight ?? (await this.getTip()).height;
		if (!Number.isFinite(top) || top < 0) return [];
		const count = Math.min(limit, top + 1);
		const heights = Array.from({ length: count }, (_, i) => top - i);
		const headers = await Promise.all(heights.map((h) => this.electrum.getBlockHeader(h)));
		return headers.map((hex, i) => {
			const d = decodeBlockHeader(hex);
			return {
				height: heights[i],
				hash: d.hash,
				time: d.time,
				// Not derivable from an Electrum block header alone (see JSDoc) — a
				// Core-RPC enrichment bead (cairn-zoz8.10) fills these when configured.
				txCount: 0,
				size: 0,
				weight: 0,
				medianFee: null,
				feeRange: null
			};
		});
	}

	async getBlock(hashOrHeight: string | number): Promise<BlockDetail> {
		let hash: string;
		if (typeof hashOrHeight === 'number' || /^\d{1,7}$/.test(String(hashOrHeight))) {
			hash = await this.esplora.getBlockHashAtHeight(Number(hashOrHeight));
		} else {
			hash = String(hashOrHeight);
		}
		const block = await this.esplora.getBlockByHash(hash);

		// mempool.space extras (fees, miner) live on the /v1/blocks summaries.
		let extras: EsploraBlock['extras'];
		try {
			const summaries = await this.esplora.getBlocks(block.height);
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
		const [block, rawTxs, tipHeight] = await Promise.all([
			this.esplora.getBlockByHash(hash),
			this.esplora.getBlockTxs(hash, page * BLOCK_TXS_PAGE_SIZE),
			this.esplora.getTipHeight()
		]);
		return {
			txs: rawTxs.map((tx) => toTxDetail(tx, tipHeight)),
			total: block.tx_count
		};
	}

	async getTx(txid: string): Promise<TxDetail> {
		// All three fetches ride the same round trip. Output spent-ness is a
		// nice-to-have, so its promise carries its own catch — it resolves to
		// `undefined` on failure rather than rejecting the whole Promise.all, which
		// preserves the degrade-to-null behavior while keeping the fetch concurrent
		// with tx/tipHeight instead of a second sequential trip (cairn-daej).
		const [tx, tipHeight, outspends] = await Promise.all([
			this.esplora.getTx(txid),
			this.esplora.getTipHeight(),
			this.esplora
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
	 */
	async getTxHex(txid: string): Promise<string> {
		return String(await this.electrum.getTransaction(txid, false));
	}

	/**
	 * Replace-by-fee timeline for a transaction, oldest version first.
	 * Null when the backend has no RBF index or the tx was never replaced.
	 */
	async getTxRbfInfo(txid: string): Promise<RbfInfo | null> {
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

	/** CPFP package context for an unconfirmed tx; null when not applicable. */
	async getCpfpInfo(txid: string): Promise<CpfpInfo | null> {
		const raw = (await this.esplora.getCpfp(txid)) as {
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

	async getMempoolSummary(): Promise<MempoolSummary> {
		const m = await this.esplora.getMempool();
		return { txCount: m.count, vsize: m.vsize, totalFees: m.total_fee };
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

	/** Projected next blocks by fee rate; null on plain esplora backends. */
	async getMempoolBlocks(): Promise<MempoolBlockProjection[] | null> {
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

	/** Mempool size over the recent past, oldest first; null when unavailable. */
	async getMempoolTrend(): Promise<MempoolTrendPoint[] | null> {
		const stats = await this.esplora.getMempoolStatistics();
		if (!stats || stats.length === 0) return null;
		return stats
			.map((s) => ({
				time: s.added,
				// Statistics report weight units; virtual bytes = weight / 4.
				vsize: Math.round(s.mempool_byte_weight / 4),
				txCount: s.count
			}))
			.sort((a, b) => a.time - b.time);
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
		if (await this.esplora.supportsV1()) {
			return this.esplora.getBtcUsdPrice();
		}
		return fetchPublicBtcUsdPrice();
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
	// TODO(depends on cairn-zoz8.7 merge): the CoreRpcClient lives at
	// ../bitcoinCore/client (built by the sibling bead). It is imported
	// DYNAMICALLY rather than at the top of this module on purpose: a static
	// import of a not-yet-merged file would break loading of ChainService for
	// every unrelated caller. The dynamic import resolves only when an admin
	// actually runs the test, and can become a plain top-level `import` (matching
	// testElectrum above) once the client module has merged. It stays INSIDE this
	// try/catch (not hoisted above it) so a resolution failure — the expected
	// state of any worktree that hasn't merged cairn-zoz8.7 yet — degrades to the
	// same `{ ok: false, error }` shape as a real connection failure, instead of
	// throwing past this action into an unhandled 500 (caught live: this exact
	// gap 500'd before the import moved inside the try).
	try {
		const { CoreRpcClient } = await import('../bitcoinCore/client');
		const client = new CoreRpcClient({
			url: cfg.url,
			user: cfg.user,
			pass: cfg.pass,
			timeoutMs: 8_000
		});
		try {
			const pong = await client.ping();
			if (!pong.ok) {
				return { ok: false, error: pong.error ?? 'Bitcoin Core did not respond to a ping.' };
			}
			const info = await client.getBlockchainInfo();
			return { ok: true, blockHeight: info.blocks, chain: info.chain };
		} finally {
			client.close();
		}
	} catch (e) {
		// Catches BOTH a real connection/auth failure from the client above AND —
		// in any worktree that hasn't merged cairn-zoz8.7 yet — the dynamic
		// import itself failing to resolve. Keeping the import inside this
		// try/catch (not hoisted above it) means that gap degrades to the same
		// `{ ok: false, error }` shape as a real failure instead of throwing past
		// this action into an unhandled 500 (reproduced live during manual
		// verification before this fix).
		return { ok: false, error: e instanceof Error ? e.message : String(e) };
	}
}
