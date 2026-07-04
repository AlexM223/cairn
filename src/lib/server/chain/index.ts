// ChainService: the facade routes and features import for all chain data.
// Explorer-rich data comes from an esplora-compatible HTTP API; wallet/address
// balances+history and node liveness come from the Electrum protocol server.

import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { getChainConfig } from '../settings';
import { ElectrumClient } from '../electrum/client';
import type { ElectrumBalance, ElectrumHistoryItem } from '../electrum/client';
import { EsploraApi } from './esplora';
import type { EsploraBlock, EsploraTx } from './esplora';
import type {
	AddressInfo,
	AddressTx,
	BlockDetail,
	BlockSummary,
	DifficultyAdjustment,
	DifficultyInfo,
	FeeEstimates,
	FeeHistogram,
	MempoolBlockProjection,
	MempoolSummary,
	MempoolTrendPoint,
	NodeInfo,
	TxDetail,
	TxVin,
	TxVout
} from '$lib/types';

const BLOCK_TXS_PAGE_SIZE = 25;

// --------------------------------------------------------------------- helpers

/** Block hash = double-sha256 of the 80-byte header, displayed byte-reversed. */
function blockHashFromHeader(headerHex: string): string {
	const hash = sha256(sha256(hexToBytes(headerHex)));
	hash.reverse();
	return bytesToHex(hash);
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
			? { txid: null, vout: null, address: null, value: null, coinbase: true }
			: {
					txid: v.txid,
					vout: v.vout,
					address: v.prevout?.scriptpubkey_address ?? null,
					value: v.prevout?.value ?? null,
					coinbase: false
				}
	);
	const vout: TxVout[] = tx.vout.map((v, i) => ({
		address: v.scriptpubkey_address ?? null,
		value: v.value,
		scriptType: v.scriptpubkey_type,
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

/** Net effect of a tx on one address, in sats. */
function addressDelta(tx: EsploraTx, address: string): number {
	let delta = 0;
	for (const out of tx.vout) {
		if (out.scriptpubkey_address === address) delta += out.value;
	}
	for (const inp of tx.vin) {
		if (!inp.is_coinbase && inp.prevout?.scriptpubkey_address === address) {
			delta -= inp.prevout.value;
		}
	}
	return delta;
}

// ------------------------------------------------------------------ ChainService

export class ChainService {
	readonly electrum: ElectrumClient;
	readonly esplora: EsploraApi;
	private readonly config: ReturnType<typeof getChainConfig>;

	constructor(config = getChainConfig()) {
		this.config = config;
		this.electrum = new ElectrumClient({
			host: config.electrumHost,
			port: config.electrumPort,
			tls: config.electrumTls
		});
		this.esplora = new EsploraApi(config.esploraUrl);
	}

	close(): void {
		this.electrum.close();
	}

	// ------------------------------------------------------------- explorer data

	async getTip(): Promise<{ height: number; hash: string }> {
		const [height, hash] = await Promise.all([
			this.esplora.getTipHeight(),
			this.esplora.getTipHash()
		]);
		return { height, hash };
	}

	/** Recent blocks, newest first. Pages the esplora /blocks endpoint as needed. */
	async getRecentBlocks(limit = 10, fromHeight?: number): Promise<BlockSummary[]> {
		const out: BlockSummary[] = [];
		let start = fromHeight;
		// Each esplora page returns ~10 summaries; cap the loop defensively.
		for (let i = 0; i < 10 && out.length < limit; i++) {
			const page = await this.esplora.getBlocks(start);
			if (page.length === 0) break;
			for (const b of page) {
				if (out.length < limit) out.push(toBlockSummary(b));
			}
			const last = page[page.length - 1];
			if (last.height === 0) break;
			start = last.height - 1;
		}
		return out;
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
		} catch {
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
		const [tx, tipHeight] = await Promise.all([
			this.esplora.getTx(txid),
			this.esplora.getTipHeight()
		]);
		// Output spent-ness is nice-to-have; degrade to nulls on failure.
		let outspends: (boolean | null)[] | undefined;
		try {
			outspends = (await this.esplora.getTxOutspends(txid)).map((o) => o.spent ?? null);
		} catch {
			outspends = undefined;
		}
		return toTxDetail(tx, tipHeight, outspends);
	}

	async getAddressInfo(address: string): Promise<AddressInfo> {
		const a = await this.esplora.getAddress(address);
		const chain = a.chain_stats;
		const mem = a.mempool_stats;
		return {
			address: a.address,
			scriptType: detectAddressType(a.address),
			confirmedBalance: chain.funded_txo_sum - chain.spent_txo_sum,
			unconfirmedBalance: mem.funded_txo_sum - mem.spent_txo_sum,
			txCount: chain.tx_count + mem.tx_count,
			totalReceived: chain.funded_txo_sum,
			totalSent: chain.spent_txo_sum,
			used: chain.tx_count + mem.tx_count > 0
		};
	}

	async getAddressTxs(address: string, afterTxid?: string): Promise<AddressTx[]> {
		const txs = await this.esplora.getAddressTxs(address, afterTxid);
		return txs.map((tx) => ({
			txid: tx.txid,
			height: tx.status.confirmed ? (tx.status.block_height ?? 0) : 0,
			time: tx.status.confirmed ? (tx.status.block_time ?? null) : null,
			fee: tx.vin.some((v) => v.is_coinbase) ? null : (tx.fee ?? null),
			delta: addressDelta(tx, address)
		}));
	}

	async getMempoolSummary(): Promise<MempoolSummary> {
		const m = await this.esplora.getMempool();
		return { txCount: m.count, vsize: m.vsize, totalFees: m.total_fee };
	}

	/** Fee-rate distribution of the current mempool; null when unavailable. */
	async getFeeHistogram(): Promise<FeeHistogram | null> {
		const m = await this.esplora.getMempool();
		return Array.isArray(m.fee_histogram) && m.fee_histogram.length > 0
			? m.fee_histogram
			: null;
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
		return this.esplora.getFeeEstimates();
	}

	/**
	 * Current difficulty-epoch state. Prefers the mempool.space endpoint;
	 * on plain esplora it derives everything from the tip block and the
	 * first block of the epoch (two cheap, cached lookups).
	 */
	async getDifficultyInfo(): Promise<DifficultyInfo> {
		const EPOCH = 2016;
		const TARGET_SECONDS = 600;

		const tipHash = await this.esplora.getTipHash();
		const tip = await this.esplora.getBlockByHash(tipHash);
		const epochStartHeight = Math.floor(tip.height / EPOCH) * EPOCH;
		const blocksIntoEpoch = tip.height - epochStartHeight + 1;
		const nextRetargetHeight = epochStartHeight + EPOCH;

		const base: DifficultyInfo = {
			currentDifficulty: tip.difficulty,
			tipHeight: tip.height,
			epochStartHeight,
			nextRetargetHeight,
			blocksIntoEpoch,
			blocksRemaining: nextRetargetHeight - tip.height,
			progressPercent: (blocksIntoEpoch / EPOCH) * 100,
			projectedChangePercent: null,
			previousChangePercent: null,
			avgBlockTimeSeconds: null,
			estimatedRetargetDate: null
		};

		const v1 = await this.esplora.getDifficultyAdjustment();
		if (v1) {
			return {
				...base,
				progressPercent: v1.progressPercent,
				blocksRemaining: v1.remainingBlocks,
				nextRetargetHeight: v1.nextRetargetHeight,
				projectedChangePercent: v1.difficultyChange,
				previousChangePercent: v1.previousRetarget,
				avgBlockTimeSeconds: v1.timeAvg / 1000,
				estimatedRetargetDate: Math.round(v1.estimatedRetargetDate / 1000)
			};
		}

		// Plain esplora: measure this epoch's pace directly.
		try {
			const startHash = await this.esplora.getBlockHashAtHeight(epochStartHeight);
			const start = await this.esplora.getBlockByHash(startHash);
			const elapsed = tip.timestamp - start.timestamp;
			const intervals = Math.max(1, tip.height - epochStartHeight);
			const avg = elapsed / intervals;
			// Retarget multiplier = target/actual pace, clamped to 4x either way
			// (the consensus rule) — expressed here as a percent change.
			const projected = Math.max(-75, Math.min(300, (TARGET_SECONDS / avg - 1) * 100));
			return {
				...base,
				avgBlockTimeSeconds: avg,
				projectedChangePercent: projected,
				estimatedRetargetDate: tip.timestamp + base.blocksRemaining * avg
			};
		} catch {
			return base;
		}
	}

	/** Recent difficulty retargets, oldest first; null when history is unavailable. */
	async getDifficultyHistory(limit = 10): Promise<DifficultyAdjustment[] | null> {
		const raw = await this.esplora.getDifficultyHistory('1y');
		if (!raw || raw.length === 0) return null;
		// Tuples arrive newest first: [timestamp, height, difficulty, change].
		const oldestFirst = [...raw].sort((a, b) => a[1] - b[1]);
		const out: DifficultyAdjustment[] = oldestFirst.map(([time, height, difficulty], i) => {
			const prev = i > 0 ? oldestFirst[i - 1][2] : null;
			return {
				time,
				height,
				difficulty,
				changePercent: prev ? ((difficulty - prev) / prev) * 100 : null
			};
		});
		return out.slice(-limit);
	}

	/** Network hashrate in H/s. Falls back to difficulty * 2^32 / 600. */
	async getHashrate(): Promise<number | null> {
		const direct = await this.esplora.getHashrate();
		if (direct !== null) return direct;
		try {
			const tipHash = await this.esplora.getTipHash();
			const block = await this.esplora.getBlockByHash(tipHash);
			return (block.difficulty * 2 ** 32) / 600;
		} catch {
			return null;
		}
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
	instance = null;
	old?.close();
}

// ---------------------------------------------------------------- test helpers

export async function testElectrum(cfg: {
	host: string;
	port: number;
	tls: boolean;
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
	url: string
): Promise<{ ok: boolean; tipHeight?: number; error?: string }> {
	try {
		const api = new EsploraApi(url);
		const tipHeight = await api.getTipHeight();
		if (!Number.isFinite(tipHeight)) {
			return { ok: false, error: 'Server did not return a numeric tip height' };
		}
		return { ok: true, tipHeight };
	} catch (e) {
		return { ok: false, error: e instanceof Error ? e.message : String(e) };
	}
}
