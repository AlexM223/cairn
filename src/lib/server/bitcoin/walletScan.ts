// Wallet scanning from an xpub: BIP44-style gap-limit discovery over Electrum,
// with tx details filled in from the esplora backend via ChainService.

import type { WalletAddress, WalletTx } from '$lib/types';
import { parseXpub, deriveAddress, addressToScripthash } from './xpub';
import type { ParsedXpub } from './xpub';
import { getChain } from '../chain/index';
import type { ElectrumBalance, ElectrumHistoryItem } from '../electrum/client';

const GAP_LIMIT = 20;
const BATCH_SIZE = 20;
const HARD_CAP = 400; // per chain (receive / change)
const TX_DETAIL_CAP = 50;
const TX_FETCH_CONCURRENCY = 8;
const CACHE_TTL_MS = 60_000;

export interface WalletScanResult {
	addresses: WalletAddress[];
	txs: WalletTx[];
	/** Confirmed balance in sats. */
	confirmed: number;
	/** Unconfirmed delta in sats. */
	unconfirmed: number;
}

interface ScannedAddress extends WalletAddress {
	history: ElectrumHistoryItem[];
	confirmedSats: number;
	unconfirmedSats: number;
}

// --------------------------------------------------------------------- scanning

async function scanChain(parsed: ParsedXpub, change: 0 | 1): Promise<ScannedAddress[]> {
	const chain = getChain();
	const out: ScannedAddress[] = [];
	let consecutiveUnused = 0;
	let index = 0;

	while (consecutiveUnused < GAP_LIMIT && index < HARD_CAP) {
		const batch: { address: string; path: string; index: number }[] = [];
		for (let i = 0; i < BATCH_SIZE && index + i < HARD_CAP; i++) {
			const { address, path } = deriveAddress(parsed, change, index + i);
			batch.push({ address, path, index: index + i });
		}
		const scripthashes = batch.map((b) => addressToScripthash(b.address));

		const [histories, balances] = await Promise.all([
			chain.electrum.batchRequest(
				scripthashes.map((sh) => ({ method: 'blockchain.scripthash.get_history', params: [sh] }))
			) as Promise<ElectrumHistoryItem[][]>,
			chain.electrum.batchRequest(
				scripthashes.map((sh) => ({ method: 'blockchain.scripthash.get_balance', params: [sh] }))
			) as Promise<ElectrumBalance[]>
		]);

		for (let i = 0; i < batch.length; i++) {
			const history = histories[i] ?? [];
			const balance = balances[i] ?? { confirmed: 0, unconfirmed: 0 };
			const used = history.length > 0;
			consecutiveUnused = used ? 0 : consecutiveUnused + 1;
			out.push({
				address: batch[i].address,
				derivationPath: batch[i].path,
				index: batch[i].index,
				change: change === 1,
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

async function collectWalletTxs(scanned: ScannedAddress[]): Promise<WalletTx[]> {
	const chain = getChain();
	const walletAddresses = new Set(scanned.map((a) => a.address));

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

	const txs: WalletTx[] = [];
	for (let i = 0; i < recent.length; i += TX_FETCH_CONCURRENCY) {
		const chunk = recent.slice(i, i + TX_FETCH_CONCURRENCY);
		const results = await Promise.all(
			chunk.map(async ([txid, height]): Promise<WalletTx | null> => {
				try {
					const tx = await chain.getTx(txid);
					let delta = 0;
					for (const out of tx.vout) {
						if (out.address && walletAddresses.has(out.address)) delta += out.value;
					}
					for (const vin of tx.vin) {
						if (!vin.coinbase && vin.address && walletAddresses.has(vin.address)) {
							delta -= vin.value ?? 0;
						}
					}
					return { txid, height, time: tx.blockTime, delta, fee: tx.fee };
				} catch {
					// Detail fetch failed (esplora hiccup) — omit rather than guess.
					return null;
				}
			})
		);
		for (const r of results) if (r) txs.push(r);
	}
	return txs;
}

async function doScan(xpub: string): Promise<WalletScanResult> {
	const parsed = parseXpub(xpub);
	const [receive, change] = await Promise.all([scanChain(parsed, 0), scanChain(parsed, 1)]);
	const scanned = [...receive, ...change];

	const txs = await collectWalletTxs(scanned);

	let confirmed = 0;
	let unconfirmed = 0;
	for (const a of scanned) {
		confirmed += a.confirmedSats;
		unconfirmed += a.unconfirmedSats;
	}

	const addresses: WalletAddress[] = scanned.map(
		({ history: _h, confirmedSats: _c, unconfirmedSats: _u, ...addr }) => addr
	);
	return { addresses, txs, confirmed, unconfirmed };
}

// ----------------------------------------------------------------------- cache

const scanCache = new Map<string, { expires: number; promise: Promise<WalletScanResult> }>();

/**
 * Scan a wallet (xpub/ypub/zpub) over Electrum.
 * Results are cached in-process for 60s per xpub.
 */
export function scanWallet(xpub: string): Promise<WalletScanResult> {
	const key = xpub.trim();
	const now = Date.now();
	const hit = scanCache.get(key);
	if (hit && hit.expires > now) return hit.promise;

	const promise = doScan(key);
	scanCache.set(key, { expires: now + CACHE_TTL_MS, promise });
	promise.catch(() => {
		// Never cache failures (and never leave an unhandled rejection).
		if (scanCache.get(key)?.promise === promise) scanCache.delete(key);
	});
	return promise;
}

/** Drop cached scan results for one xpub, or all when omitted. */
export function invalidateWalletCache(xpub?: string): void {
	if (xpub === undefined) scanCache.clear();
	else scanCache.delete(xpub.trim());
}

// --------------------------------------------------------------------- helpers

/**
 * First `count` receive addresses for the import-wizard preview.
 * Pure derivation — no network calls.
 */
export function derivePreviewAddresses(
	xpub: string,
	count = 5
): { address: string; path: string }[] {
	const parsed = parseXpub(xpub);
	const out: { address: string; path: string }[] = [];
	for (let i = 0; i < count; i++) {
		out.push(deriveAddress(parsed, 0, i));
	}
	return out;
}

/**
 * Next unused index on the given chain (0 = receive, 1 = change), based on a
 * (possibly cached) wallet scan. Used by the receive-address endpoint.
 */
export async function findNextUnusedIndex(xpub: string, change: 0 | 1 = 0): Promise<number> {
	const scan = await scanWallet(xpub);
	const isChange = change === 1;
	let lastUsed = -1;
	for (const a of scan.addresses) {
		if (a.change === isChange && a.used) lastUsed = Math.max(lastUsed, a.index);
	}
	return lastUsed + 1;
}
