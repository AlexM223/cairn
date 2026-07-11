// Esplora-compatible HTTP API client (mempool.space, blockstream.info, self-hosted
// esplora/mempool instances). Uses global fetch, with a small in-memory TTL cache.

import http from 'node:http';
import https from 'node:https';
import type { Agent } from 'node:http';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { childLogger } from '../logger';

const log = childLogger('esplora');

export interface EsploraProxyOptions {
	socks5Host?: string | null;
	socks5Port?: number | null;
}

const REQUEST_TIMEOUT_MS = 12_000;
const SHORT_TTL_MS = 10_000; // tip / mempool / fees
const IMMUTABLE_TTL_MS = 10 * 60_000; // confirmed txs, blocks
const PRICE_TTL_MS = 5 * 60_000; // spot price moves slowly; don't hammer the source

// ------------------------------------------------------------------ payload types

export interface EsploraBlock {
	id: string;
	height: number;
	version: number;
	timestamp: number;
	tx_count: number;
	size: number;
	weight: number;
	merkle_root: string;
	previousblockhash: string | null;
	mediantime?: number;
	nonce: number;
	bits: number;
	difficulty: number;
	/** mempool.space /v1/blocks only. */
	extras?: {
		medianFee?: number;
		feeRange?: number[];
		totalFees?: number;
		reward?: number;
		pool?: { name?: string };
	};
}

export interface EsploraVin {
	txid: string;
	vout: number;
	is_coinbase: boolean;
	prevout: EsploraVout | null;
	scriptsig?: string;
	sequence?: number;
	witness?: string[];
}

export interface EsploraVout {
	scriptpubkey: string;
	scriptpubkey_asm?: string;
	scriptpubkey_type: string;
	scriptpubkey_address?: string;
	value: number;
}

export interface EsploraTx {
	txid: string;
	version: number;
	locktime: number;
	vin: EsploraVin[];
	vout: EsploraVout[];
	size: number;
	weight: number;
	sigops?: number;
	fee: number;
	status: {
		confirmed: boolean;
		block_height?: number;
		block_hash?: string;
		block_time?: number;
	};
}

export interface EsploraOutspend {
	spent: boolean;
	txid?: string;
	vin?: number;
	status?: { confirmed: boolean; block_height?: number };
}

export interface EsploraAddressStats {
	funded_txo_count: number;
	funded_txo_sum: number;
	spent_txo_count: number;
	spent_txo_sum: number;
	tx_count: number;
}

export interface EsploraAddress {
	address: string;
	chain_stats: EsploraAddressStats;
	mempool_stats: EsploraAddressStats;
}

export interface EsploraMempool {
	count: number;
	vsize: number;
	total_fee: number;
	/** [feeRate sat/vB, vsize] pairs, highest rate first. */
	fee_histogram?: [number, number][];
}

/** mempool.space projected block template (/v1/fees/mempool-blocks). */
export interface EsploraMempoolBlock {
	blockSize: number;
	blockVSize: number;
	nTx: number;
	totalFees: number;
	medianFee: number;
	feeRange: number[];
}

/** One sample from mempool.space /v1/statistics (mempool over time). */
export interface EsploraMempoolStat {
	added: number; // unix seconds
	count: number;
	vbytes_per_second: number;
	mempool_byte_weight: number;
	total_fee: number;
}

/** mempool.space /v1/difficulty-adjustment payload. */
export interface EsploraDifficultyAdjustment {
	progressPercent: number;
	difficultyChange: number; // projected retarget, percent
	estimatedRetargetDate: number; // unix milliseconds
	remainingBlocks: number;
	remainingTime: number; // milliseconds
	previousRetarget: number; // percent applied at the last retarget
	nextRetargetHeight: number;
	timeAvg: number; // average block interval this epoch, milliseconds
	expectedBlocks: number;
}

export interface NormalizedFees {
	fastest: number;
	halfHour: number;
	hour: number;
	economy: number;
}

/**
 * Global `fetch` (undici) collapses every network failure — DNS, refused,
 * TLS, timeout — into a generic `TypeError: fetch failed`, with the actual
 * cause (e.g. `Error: getaddrinfo ENOTFOUND ...`, `ECONNREFUSED`, a
 * certificate error) attached only as `.cause`, which `.message` alone never
 * surfaces. Without unwrapping it, every "can't reach chain data" error looks
 * identical regardless of whether it's bad DNS, blocked egress, or a
 * misconfigured host — impossible to diagnose from the UI alone.
 */
function fetchErrorDetail(e: unknown): string {
	if (!(e instanceof Error)) return String(e);
	const parts: string[] = [e.message];
	let cause: unknown = e.cause;
	for (let i = 0; i < 3 && cause; i++) {
		if (cause instanceof Error) {
			parts.push(cause.message);
			cause = cause.cause;
		} else {
			parts.push(String(cause));
			break;
		}
	}
	return parts.join(': ');
}

export class EsploraHttpError extends Error {
	constructor(
		public readonly status: number,
		public readonly path: string,
		bodySnippet: string
	) {
		super(`Esplora GET ${path} failed with HTTP ${status}: ${bodySnippet}`);
		this.name = 'EsploraHttpError';
	}
}

interface CacheEntry {
	expires: number;
	promise: Promise<unknown>;
}

export class EsploraApi {
	private readonly baseUrl: string;
	private cache = new Map<string, CacheEntry>();
	/** Whether mempool.space-style /v1/ endpoints exist. null = not probed yet. */
	private hasV1: boolean | null = null;
	/** SOCKS5 proxy agent when a Tor/SOCKS proxy is configured; null = direct. */
	private readonly proxyAgent: Agent | null;

	constructor(baseUrl: string, proxy?: EsploraProxyOptions) {
		this.baseUrl = baseUrl.replace(/\/+$/, '');
		// socks5h:// keeps DNS resolution on the proxy side (no DNS leak, and
		// .onion hosts resolve) — the whole point of routing over Tor (cairn-oh7a).
		this.proxyAgent =
			proxy?.socks5Host && proxy?.socks5Port
				? new SocksProxyAgent(`socks5h://${proxy.socks5Host}:${proxy.socks5Port}`)
				: null;
	}

	// ------------------------------------------------------------------ plumbing

	private async fetchPath(path: string): Promise<unknown> {
		const url = this.baseUrl + path;
		let status: number;
		let ok: boolean;
		let text: string;
		try {
			// Global fetch (undici) can't take a SOCKS dispatcher, so when a proxy is
			// configured we fall back to node's http/https with a SocksProxyAgent.
			const res = this.proxyAgent ? await this.proxiedGet(url) : await this.directGet(url);
			status = res.status;
			ok = res.ok;
			text = res.text;
		} catch (e) {
			throw new Error(`Esplora GET ${path} failed: ${fetchErrorDetail(e)}`);
		}
		if (!ok) {
			throw new EsploraHttpError(status, path, text.slice(0, 200));
		}
		// Some endpoints return plain text (block hash, tip height).
		try {
			return JSON.parse(text) as unknown;
		} catch {
			return text.trim();
		}
	}

	private async directGet(url: string): Promise<{ status: number; ok: boolean; text: string }> {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
		try {
			const res = await fetch(url, {
				signal: controller.signal,
				headers: { accept: 'application/json, text/plain' }
			});
			return { status: res.status, ok: res.ok, text: await res.text() };
		} finally {
			clearTimeout(timer);
		}
	}

	/** GET over node http/https through the configured SOCKS5 proxy agent. */
	private proxiedGet(url: string): Promise<{ status: number; ok: boolean; text: string }> {
		const lib = url.startsWith('https:') ? https : http;
		return new Promise((resolve, reject) => {
			const req = lib.get(
				url,
				{
					agent: this.proxyAgent ?? undefined,
					headers: { accept: 'application/json, text/plain' },
					timeout: REQUEST_TIMEOUT_MS
				},
				(res) => {
					const chunks: Buffer[] = [];
					res.on('data', (c: Buffer) => chunks.push(c));
					res.on('end', () => {
						const status = res.statusCode ?? 0;
						resolve({
							status,
							ok: status >= 200 && status < 300,
							text: Buffer.concat(chunks).toString('utf8')
						});
					});
					res.on('error', reject);
				}
			);
			req.on('timeout', () => req.destroy(new Error(`timed out after ${REQUEST_TIMEOUT_MS}ms`)));
			req.on('error', reject);
		});
	}

	/** GET with per-path TTL caching. Failed requests are not cached. */
	private get<T>(path: string, ttlMs: number): Promise<T> {
		// Normalize so equivalent spellings share one cache entry: collapse
		// duplicate slashes and strip a trailing slash (keeping the leading one).
		path = path.replace(/\/{2,}/g, '/').replace(/(.+)\/$/, '$1');
		const now = Date.now();
		const hit = this.cache.get(path);
		if (hit && hit.expires > now) return hit.promise as Promise<T>;
		// Opportunistic sweep so the cache can't grow without bound.
		if (this.cache.size > 500) {
			for (const [k, v] of this.cache) if (v.expires <= now) this.cache.delete(k);
		}
		const promise = this.fetchPath(path);
		this.cache.set(path, { expires: now + ttlMs, promise });
		promise.catch(() => this.cache.delete(path));
		return promise as Promise<T>;
	}

	/** Public probe: does the configured backend expose mempool.space /v1/ endpoints? */
	supportsV1(): Promise<boolean> {
		return this.probeV1();
	}

	/**
	 * BTC→USD spot from this backend's mempool.space /v1/prices endpoint.
	 * Null on a plain esplora backend (no such endpoint) or on any failure —
	 * the caller decides whether to fall back elsewhere.
	 */
	async getBtcUsdPrice(): Promise<number | null> {
		if (!(await this.probeV1())) return null;
		try {
			const body = await this.get<{ USD?: number }>('/v1/prices', PRICE_TTL_MS);
			return body && typeof body.USD === 'number' && body.USD > 0 ? body.USD : null;
		} catch (e) {
			log.debug({ err: e, baseUrl: this.baseUrl }, 'v1/prices fetch failed');
			return null;
		}
	}

	/**
	 * Probe once whether the server exposes mempool.space /v1/ endpoints
	 * (mempool.space does; plain esplora like blockstream.info does not).
	 * Network errors leave the answer undecided so it is re-probed later.
	 */
	private async probeV1(): Promise<boolean> {
		if (this.hasV1 !== null) return this.hasV1;
		try {
			const fees = await this.get<unknown>('/v1/fees/recommended', SHORT_TTL_MS);
			const ok = typeof fees === 'object' && fees !== null && 'fastestFee' in fees;
			this.hasV1 = ok;
			return ok;
		} catch (e) {
			if (e instanceof EsploraHttpError && e.status >= 400 && e.status < 500) {
				this.hasV1 = false;
				log.debug({ baseUrl: this.baseUrl }, 'backend has no mempool.space /v1 endpoints');
				return false;
			}
			log.debug({ err: e, baseUrl: this.baseUrl }, 'v1 probe inconclusive (network); will retry');
			return false; // undecided (network problem) — do not persist
		}
	}

	// ------------------------------------------------------------------ tip / blocks

	async getTipHeight(): Promise<number> {
		const raw = await this.get<unknown>('/blocks/tip/height', SHORT_TTL_MS);
		return typeof raw === 'number' ? raw : parseInt(String(raw), 10);
	}

	async getTipHash(): Promise<string> {
		return String(await this.get<unknown>('/blocks/tip/hash', SHORT_TTL_MS));
	}

	async getBlockByHash(hash: string): Promise<EsploraBlock> {
		return this.get<EsploraBlock>(`/block/${hash}`, IMMUTABLE_TTL_MS);
	}

	async getBlockHashAtHeight(height: number): Promise<string> {
		return String(await this.get<unknown>(`/block-height/${height}`, IMMUTABLE_TTL_MS));
	}

	/**
	 * Recent block summaries (esplora returns 10 per page, newest first).
	 * On mempool.space the /v1/blocks endpoint is used instead so summaries
	 * carry `extras` (medianFee, feeRange, totalFees, reward, pool); on plain
	 * esplora those fields are simply absent and callers get nulls.
	 */
	async getBlocks(startHeight?: number): Promise<EsploraBlock[]> {
		const suffix = startHeight !== undefined ? `/${startHeight}` : '';
		if (await this.probeV1()) {
			try {
				return await this.get<EsploraBlock[]>(`/v1/blocks${suffix}`, SHORT_TTL_MS);
			} catch (e) {
				log.debug({ err: e, baseUrl: this.baseUrl }, 'v1/blocks failed; falling back to /blocks');
				// fall through to the plain esplora endpoint
			}
		}
		return this.get<EsploraBlock[]>(`/blocks${suffix}`, SHORT_TTL_MS);
	}

	/** 25 txs per page; startIndex must be a multiple of 25. */
	async getBlockTxs(hash: string, startIndex = 0): Promise<EsploraTx[]> {
		return this.get<EsploraTx[]>(`/block/${hash}/txs/${startIndex}`, IMMUTABLE_TTL_MS);
	}

	async getBlockTxids(hash: string): Promise<string[]> {
		return this.get<string[]>(`/block/${hash}/txids`, IMMUTABLE_TTL_MS);
	}

	// ------------------------------------------------------------------ txs

	async getTx(txid: string): Promise<EsploraTx> {
		// Cache short first; once confirmed, re-cache long.
		const tx = await this.get<EsploraTx>(`/tx/${txid}`, SHORT_TTL_MS);
		if (tx.status?.confirmed) {
			const hit = this.cache.get(`/tx/${txid}`);
			if (hit) hit.expires = Date.now() + IMMUTABLE_TTL_MS;
		}
		return tx;
	}

	async getTxOutspends(txid: string): Promise<EsploraOutspend[]> {
		return this.get<EsploraOutspend[]>(`/tx/${txid}/outspends`, SHORT_TTL_MS);
	}

	/** Raw transaction serialization as hex. Immutable per txid. */
	async getTxHex(txid: string): Promise<string> {
		return String(await this.get<unknown>(`/tx/${txid}/hex`, IMMUTABLE_TTL_MS));
	}

	/**
	 * Replace-by-fee history for a transaction (mempool.space only).
	 * The shape is a replacement tree; callers should parse defensively.
	 */
	async getTxRbf(txid: string): Promise<unknown | null> {
		if (!(await this.probeV1())) return null;
		try {
			return await this.get<unknown>(`/v1/tx/${txid}/rbf`, SHORT_TTL_MS);
		} catch (e) {
			log.debug({ err: e, txid }, 'v1/tx/rbf fetch failed');
			return null;
		}
	}

	/** CPFP (fee-package) context for an unconfirmed tx (mempool.space only). */
	async getCpfp(txid: string): Promise<unknown | null> {
		if (!(await this.probeV1())) return null;
		try {
			return await this.get<unknown>(`/v1/cpfp/${txid}`, SHORT_TTL_MS);
		} catch (e) {
			log.debug({ err: e, txid }, 'v1/cpfp fetch failed');
			return null;
		}
	}

	// ------------------------------------------------------------------ addresses

	async getAddress(address: string): Promise<EsploraAddress> {
		return this.get<EsploraAddress>(`/address/${address}`, SHORT_TTL_MS);
	}

	/** Up to 50 txs (mempool + newest confirmed); page with afterTxid. */
	async getAddressTxs(address: string, afterTxid?: string): Promise<EsploraTx[]> {
		const path = afterTxid
			? `/address/${address}/txs/chain/${afterTxid}`
			: `/address/${address}/txs`;
		return this.get<EsploraTx[]>(path, SHORT_TTL_MS);
	}

	// ------------------------------------------------------------------ mempool / fees / mining

	async getMempool(): Promise<EsploraMempool> {
		return this.get<EsploraMempool>('/mempool', SHORT_TTL_MS);
	}

	async getFeeEstimates(): Promise<NormalizedFees> {
		if (await this.probeV1()) {
			try {
				const rec = await this.get<{
					fastestFee: number;
					halfHourFee: number;
					hourFee: number;
					economyFee: number;
				}>('/v1/fees/recommended', SHORT_TTL_MS);
				return {
					fastest: rec.fastestFee,
					halfHour: rec.halfHourFee,
					hour: rec.hourFee,
					economy: rec.economyFee
				};
			} catch (e) {
				log.debug({ err: e, baseUrl: this.baseUrl }, 'v1/fees/recommended failed; falling back to /fee-estimates');
				// fall through to /fee-estimates
			}
		}
		// Plain esplora: map of confirmation target -> sat/vB.
		const map = await this.get<Record<string, number>>('/fee-estimates', SHORT_TTL_MS);
		const target = (n: number, fallback: number): number => {
			const v = map[String(n)];
			return typeof v === 'number' ? Math.round(v * 100) / 100 : fallback;
		};
		const hour = target(6, 1);
		return {
			fastest: target(1, hour),
			halfHour: target(3, hour),
			hour,
			economy: target(144, 1)
		};
	}

	/**
	 * Projected next blocks assembled from the current mempool by fee rate.
	 * mempool.space only; null on plain esplora.
	 */
	async getMempoolBlocks(): Promise<EsploraMempoolBlock[] | null> {
		if (!(await this.probeV1())) return null;
		try {
			return await this.get<EsploraMempoolBlock[]>('/v1/fees/mempool-blocks', SHORT_TTL_MS);
		} catch (e) {
			log.debug({ err: e, baseUrl: this.baseUrl }, 'v1/fees/mempool-blocks fetch failed');
			return null;
		}
	}

	/**
	 * Mempool size samples over the last two hours (newest first).
	 * mempool.space only; null on plain esplora.
	 */
	async getMempoolStatistics(): Promise<EsploraMempoolStat[] | null> {
		if (!(await this.probeV1())) return null;
		try {
			return await this.get<EsploraMempoolStat[]>('/v1/statistics/2h', 60_000);
		} catch (e) {
			log.debug({ err: e, baseUrl: this.baseUrl }, 'v1/statistics fetch failed');
			return null;
		}
	}

	/** Live difficulty-epoch state via mempool.space; null on plain esplora. */
	async getDifficultyAdjustment(): Promise<EsploraDifficultyAdjustment | null> {
		if (!(await this.probeV1())) return null;
		try {
			return await this.get<EsploraDifficultyAdjustment>('/v1/difficulty-adjustment', SHORT_TTL_MS);
		} catch (e) {
			log.debug({ err: e, baseUrl: this.baseUrl }, 'v1/difficulty-adjustment fetch failed');
			return null;
		}
	}

	/**
	 * Historical difficulty retargets, newest first, as
	 * [timestamp, height, difficulty, change] tuples. mempool.space only.
	 */
	async getDifficultyHistory(interval = '1y'): Promise<[number, number, number, number][] | null> {
		if (!(await this.probeV1())) return null;
		try {
			return await this.get<[number, number, number, number][]>(
				`/v1/mining/difficulty-adjustments/${interval}`,
				10 * 60_000
			);
		} catch (e) {
			log.debug({ err: e, interval }, 'v1/mining/difficulty-adjustments fetch failed');
			return null;
		}
	}

	/** Current network hashrate (H/s) via mempool.space; null on plain esplora. */
	async getHashrate(): Promise<number | null> {
		if (!(await this.probeV1())) return null;
		try {
			const data = await this.get<{ currentHashrate?: number }>(
				'/v1/mining/hashrate/3d',
				SHORT_TTL_MS
			);
			return typeof data.currentHashrate === 'number' ? data.currentHashrate : null;
		} catch (e) {
			log.debug({ err: e, baseUrl: this.baseUrl }, 'v1/mining/hashrate fetch failed');
			return null;
		}
	}
}
