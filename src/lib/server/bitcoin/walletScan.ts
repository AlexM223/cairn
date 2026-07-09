// Wallet scanning from an xpub: BIP44-style gap-limit discovery over Electrum,
// with tx details filled in from the esplora backend via ChainService. The
// discovery/attribution/caching engine is the shared gapLimitScanner.ts (also
// used by multisigScan.ts); this module supplies single-sig derivation and the
// persisted-scan plumbing.

import type { WalletAddress, WalletTx } from '$lib/types';
import type { ElectrumLane } from '../electrum/pool';
import { parseXpub, deriveAddress } from './xpub';
import { runGapScan, ScanCache } from './gapLimitScanner';
import {
	persistScanResult,
	deletePersistedScan,
	clearPersistedScans
} from '../scanCachePersist';

export interface WalletScanResult {
	addresses: WalletAddress[];
	txs: WalletTx[];
	/** Confirmed balance in sats. */
	confirmed: number;
	/** Unconfirmed delta in sats. */
	unconfirmed: number;
}

// --------------------------------------------------------------------- scanning

async function doScan(xpub: string, lane: ElectrumLane): Promise<WalletScanResult> {
	const parsed = parseXpub(xpub);
	const scan = await runGapScan((chain, index) => {
		const { address, path } = deriveAddress(parsed, chain, index);
		return { address, derivationPath: path, change: chain === 1 };
	}, lane);

	const result: WalletScanResult = {
		addresses: scan.addresses,
		txs: scan.txs,
		confirmed: scan.confirmed,
		unconfirmed: scan.unconfirmed
	};
	// Persist this completed scan (one write) so a cold restart can serve it
	// instantly before re-scanning. Best-effort — never blocks or throws.
	persistScanResult('wallet', xpub, result);
	return result;
}

// ----------------------------------------------------------------------- cache

const scanCache = new ScanCache<WalletScanResult>();

/**
 * Scan a wallet (xpub/ypub/zpub) over Electrum.
 * Results are cached in-process for 60s per xpub.
 *
 * `forceRefresh` skips the cache-hit read (but still writes the cache) — the
 * startup warm pass uses it so the persisted seed it just loaded gets replaced
 * with a live scan rather than being served back to itself.
 *
 * `lane` (default 'interactive') routes the underlying Electrum traffic: the
 * background snapshot refresh (walletSync.doWalletScan) passes 'background' so a
 * scan's pipelined calls never wedge an interactive request; a cache HIT ignores
 * it (no Electrum touched), which is correct — the scan result is identical
 * regardless of which lane fetched it.
 */
export function scanWallet(
	xpub: string,
	opts: { forceRefresh?: boolean; lane?: ElectrumLane } = {}
): Promise<WalletScanResult> {
	const lane = opts.lane ?? 'interactive';
	return scanCache.fetch(xpub.trim(), () => doScan(xpub.trim(), lane), opts);
}

/**
 * Seed the in-memory cache with a scan result loaded from the persisted cache at
 * startup, so the first post-restart request serves instantly. Only fills an
 * empty/expired slot — never clobbers a fresher live scan already in flight.
 * Given a normal TTL so early requests are served; the warm pass force-refreshes
 * shortly after to replace it with live data.
 */
export function primeWalletScanCache(xpub: string, result: WalletScanResult): void {
	scanCache.prime(xpub.trim(), result);
}

/** Drop cached scan results for one xpub, or all when omitted. Also removes the
 *  persisted row(s) so a deleted wallet's stale scan can never be re-seeded. */
export function invalidateWalletCache(xpub?: string): void {
	if (xpub === undefined) {
		scanCache.clear();
		clearPersistedScans('wallet');
	} else {
		scanCache.delete(xpub.trim());
		deletePersistedScan(xpub.trim());
	}
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
