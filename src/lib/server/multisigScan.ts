// Multisig scanning: gap-limit address discovery over Electrum for M-of-N
// multisig multisigs. A multisig's p2wsh addresses hash to scripthashes exactly like
// single-sig addresses, so the discovery/attribution/caching engine is the
// shared bitcoin/gapLimitScanner.ts (also used by walletScan.ts), with
// derivation swapped for deriveMultisigAddress over the multisig's key set.
//
// Contract consumed by the multisig send flow (do not rename):
//   getMultisigUtxos(multisig)      → Promise<SpendableUtxo[]>
//   getMultisigDetail(multisig)     → { balance: {confirmed, unconfirmed}, utxos,
//                                 addresses: {address, chain, index, used}[],
//                                 history }
//   nextMultisigChangeIndex(multisig) → first unused change index

import { bytesToHex } from '@noble/hashes/utils.js';
import { deriveMultisigAddress, multisigToDescriptor } from './bitcoin/multisig';
import { annotateCoinbase } from './bitcoin/coinbaseScan';
import { addressToScripthash } from './bitcoin/xpub';
import { getChain } from './chain/index';
import { GAP_LIMIT, runGapScan, ScanCache, type GapScannedFields } from './bitcoin/gapLimitScanner';
import type { ElectrumHistoryItem } from './electrum/client';
import type { SpendableUtxo } from './bitcoin/psbt';
import {
	toMultisigConfig,
	bumpReceiveCursor,
	listMultisigs,
	getViewableMultisig,
	type MultisigRow
} from './wallets/multisig';
import { listSharedMultisigs, type ShareRole } from './multisigShares';
import { persistScanResult, deletePersistedScan, clearPersistedScans } from './scanCachePersist';

/** One scanned multisig address. Superset of the send-flow contract's
 *  `{ address, chain, index, used }` — balance/txCount feed the detail page. */
export interface MultisigScanAddress {
	address: string;
	chain: 0 | 1; // 0 = receive, 1 = change
	index: number;
	used: boolean;
	/** Confirmed + unconfirmed sats currently on this address. */
	balance: number;
	txCount: number;
}

/** One multisig transaction, shaped like the wallet history rows the UI renders. */
export interface MultisigTx {
	txid: string;
	height: number; // 0 or -1 = unconfirmed
	time: number | null; // unix seconds, null if unconfirmed
	/** Net effect on the multisig in sats (positive = received). */
	delta: number;
	fee: number | null;
}

export interface MultisigScanResult {
	addresses: MultisigScanAddress[];
	txs: MultisigTx[];
	confirmed: number; // sats
	unconfirmed: number; // sats (delta)
}

export interface MultisigDetail {
	balance: { confirmed: number; unconfirmed: number };
	utxos: SpendableUtxo[];
	addresses: MultisigScanAddress[];
	history: MultisigTx[];
}

type ScannedAddress = MultisigScanAddress & GapScannedFields & { history: ElectrumHistoryItem[] };

// ----------------------------------------------------------------- derivation

/**
 * The multisig's address at <chain>/<index> — one line, but exported so the
 * receive endpoint, the scanner, and the tests all derive through the same
 * call (and so determinism is testable without a network).
 */
export function multisigAddressAt(multisig: MultisigRow, chain: 0 | 1, index: number): string {
	return deriveMultisigAddress(toMultisigConfig(multisig), chain, index).address;
}

// ------------------------------------------------- address transparency detail

/** One cosigner's derivation path for a specific address. */
export interface MultisigAddressKeyPath {
	id: number;
	name: string;
	fingerprint: string;
	/** The key's stored account-level origin path ("m" when unknown). */
	basePath: string;
	/** Full path from the master to this address's child key: basePath + /chain/index. */
	fullPath: string;
}

/**
 * Everything needed to independently verify one multisig address in another
 * wallet tool (Caravan's "address details" view): the scripts the address
 * commits to, the BIP-67 sorted child pubkeys, and each key's full derivation
 * path. Derived on demand — never persisted, never shipped in bulk.
 */
export interface MultisigAddressDetail {
	address: string;
	chain: 0 | 1;
	index: number;
	scriptType: MultisigRow['scriptType'];
	/** p2ms script hex for the wsh forms; null for legacy p2sh. */
	witnessScript: string | null;
	/** Script hex for the sh forms (p2ms itself for p2sh, wsh program for p2sh-p2wsh); null for native p2wsh. */
	redeemScript: string | null;
	/** Child pubkeys in BIP-67 (script) order, hex. */
	sortedPubkeys: string[];
	keys: MultisigAddressKeyPath[];
}

/** Derive the full verification detail for the multisig's address at <chain>/<index>.
 *  Pure derivation (no network); throws MultisigError on invalid chain/index. */
export function multisigAddressDetailAt(
	multisig: MultisigRow,
	chain: 0 | 1,
	index: number
): MultisigAddressDetail {
	const derived = deriveMultisigAddress(toMultisigConfig(multisig), chain, index);
	return {
		address: derived.address,
		chain,
		index,
		scriptType: multisig.scriptType,
		witnessScript: derived.witnessScript ? bytesToHex(derived.witnessScript) : null,
		redeemScript: derived.redeemScript ? bytesToHex(derived.redeemScript) : null,
		sortedPubkeys: derived.sortedPubkeys.map(bytesToHex),
		keys: multisig.keys.map((k) => ({
			id: k.id,
			name: k.name,
			fingerprint: k.fingerprint,
			basePath: k.path,
			fullPath: k.path === 'm' ? `m/${chain}/${index}` : `${k.path}/${chain}/${index}`
		}))
	};
}

// ------------------------------------------------------------------- scanning

async function doScan(
	multisig: MultisigRow
): Promise<MultisigScanResult & { scanned: ScannedAddress[] }> {
	const scan = await runGapScan((chain, index) => ({
		address: multisigAddressAt(multisig, chain, index),
		chain
	}));

	// Persist ONLY the public result (never the heavy per-address `scanned`
	// histories) so a cold restart can serve it instantly. One write, best-effort.
	persistScanResult('multisig', multisigToDescriptor(toMultisigConfig(multisig)), {
		addresses: scan.addresses,
		txs: scan.txs,
		confirmed: scan.confirmed,
		unconfirmed: scan.unconfirmed
	});
	return {
		addresses: scan.addresses,
		txs: scan.txs,
		confirmed: scan.confirmed,
		unconfirmed: scan.unconfirmed,
		scanned: scan.scanned
	};
}

// ---------------------------------------------------------------------- cache

// Keyed on the multisig's receive descriptor: it captures the full key set,
// threshold, and script type, so any config difference is a different cache
// entry (and two multisigs with identical configs share one scan — correctly,
// since they'd share addresses too).
const scanCache = new ScanCache<MultisigScanResult & { scanned: ScannedAddress[] }>();

function cacheKey(multisig: MultisigRow): string {
	return multisigToDescriptor(toMultisigConfig(multisig));
}

/** Scan a multisig over Electrum. Results are cached in-process for 60s.
 *  `forceRefresh` skips the cache-hit read (the warm pass uses it to replace a
 *  persisted seed with a live scan). */
export function scanMultisig(
	multisig: MultisigRow,
	opts: { forceRefresh?: boolean } = {}
): Promise<MultisigScanResult> {
	return scanCache.fetch(cacheKey(multisig), () => doScan(multisig), opts);
}

/**
 * Seed the in-memory cache from a persisted scan at startup (see
 * scanCachePersist.ts). Keyed by the receive descriptor — the same key the live
 * cache uses. Fills only an empty/expired slot; the persisted result has no
 * per-address `scanned` histories, so seed an empty `scanned` (no consumer reads
 * it). The warm pass force-refreshes shortly after.
 */
export function primeMultisigScanCache(descriptorKey: string, result: MultisigScanResult): void {
	scanCache.prime(descriptorKey, { ...result, scanned: [] });
}

/** Drop cached scan results for one multisig, or all when omitted. Also removes
 *  the persisted row(s) so a deleted multisig's stale scan can never re-seed.
 *  Computing the cache key requires a resolvable config (threshold + keys); a
 *  malformed/partial row (e.g. deleted before its keys ever got inserted) can
 *  never have produced a cache entry in the first place, so that's swallowed
 *  rather than thrown — this must never block a deletion from completing. */
export function invalidateMultisigCache(multisig?: MultisigRow): void {
	if (multisig === undefined) {
		scanCache.clear();
		clearPersistedScans('multisig');
	} else {
		let key: string;
		try {
			key = cacheKey(multisig);
		} catch {
			return;
		}
		scanCache.delete(key);
		deletePersistedScan(key);
	}
}

// ----------------------------------------------------------- send-flow contract

/** Live spendable UTXOs for a multisig, attributed to <chain>/<index>. */
export async function getMultisigUtxos(multisig: MultisigRow): Promise<SpendableUtxo[]> {
	const chainSvc = getChain();
	const scan = await scanMultisig(multisig);
	const candidates = scan.addresses.filter((a) => a.used || a.balance > 0);

	const results = await Promise.all(
		candidates.map(async (addr) => {
			const unspent = await chainSvc.electrum.listUnspent(addressToScripthash(addr.address));
			return unspent.map((u) => ({
				txid: u.tx_hash,
				vout: u.tx_pos,
				value: u.value,
				height: u.height,
				address: addr.address,
				chain: addr.chain,
				index: addr.index
			}));
		})
	);
	// Tag mining-reward (coinbase) outputs — maturity enforcement + UI badging.
	return annotateCoinbase(results.flat());
}

/** Everything the multisig detail page (and the send flow) needs in one scan. */
export async function getMultisigDetail(multisig: MultisigRow): Promise<MultisigDetail> {
	const scan = await scanMultisig(multisig);
	const utxos = await getMultisigUtxos(multisig);
	return {
		balance: { confirmed: scan.confirmed, unconfirmed: scan.unconfirmed },
		utxos,
		addresses: scan.addresses,
		history: scan.txs
	};
}

function nextUnusedIndex(scan: MultisigScanResult, chain: 0 | 1): number {
	let lastUsed = -1;
	for (const a of scan.addresses) {
		if (a.chain === chain && a.used) lastUsed = Math.max(lastUsed, a.index);
	}
	return lastUsed + 1;
}

/** First unused change index (chain 1) from the (cached) scan — where a multisig
 *  spend's change output derives. */
export async function nextMultisigChangeIndex(multisig: MultisigRow): Promise<number> {
	return nextUnusedIndex(await scanMultisig(multisig), 1);
}

// ---------------------------------------------------------- receive addresses

function clampToGap(idx: number, nextUnused: number): number {
	// Never hand out an address beyond the gap-limit window, or wallets that
	// follow BIP44 discovery would miss funds sent to it.
	return Math.min(idx, nextUnused + GAP_LIMIT - 1);
}

/**
 * The receive address currently "on display" — the most recently handed-out
 * index (cursor − 1) or the next unused one, whichever is further along.
 * Read-only: never advances the cursor.
 */
export async function peekMultisigReceiveAddress(
	multisig: MultisigRow
): Promise<{ address: string; index: number }> {
	const nextUnused = nextUnusedIndex(await scanMultisig(multisig), 0);
	const idx = clampToGap(Math.max(nextUnused, multisig.receiveCursor - 1), nextUnused);
	return { address: multisigAddressAt(multisig, 0, idx), index: idx };
}

/**
 * Hand out the next unused receive address and advance the cursor.
 * `afterIndex` (optional) requests an address strictly after the one the
 * caller is already showing, so repeated clicks always swap to a fresh one.
 * Cycles within the gap window — the index never exceeds nextUnused + 19.
 */
export async function nextMultisigReceiveAddress(
	multisig: MultisigRow,
	afterIndex?: number
): Promise<{ address: string; index: number }> {
	const nextUnused = nextUnusedIndex(await scanMultisig(multisig), 0);
	const after = Number.isInteger(afterIndex) ? (afterIndex as number) : -1;
	const idx = clampToGap(Math.max(nextUnused, multisig.receiveCursor, after + 1), nextUnused);
	bumpReceiveCursor(multisig.userId, multisig.id, idx);
	return { address: multisigAddressAt(multisig, 0, idx), index: idx };
}

// ------------------------------------------------------------------ summaries

/** What multisig lists (wallets page, /wallets/multisig, API) render per multisig. */
export interface MultisigSummary {
	id: number;
	name: string;
	threshold: number;
	totalKeys: number;
	scriptType: MultisigRow['scriptType'];
	createdAt: string;
	balance: number; // confirmed sats
	unconfirmed: number; // sats delta
	lastActivity: number | null; // unix seconds
	/**
	 * The caller's relationship to this wallet: 'owner' for wallets they own, or
	 * the share role for wallets shared with them (collaborative custody). Lets
	 * the list distinguish "your wallets" from "shared with you".
	 */
	role: 'owner' | ShareRole;
	/** Owner's display name when this wallet was shared with the caller; null for
	 *  wallets they own outright. Drives the "Shared by X" badge. */
	sharedBy: string | null;
}

function lastActivityOf(scan: MultisigScanResult): number | null {
	let latest: number | null = null;
	let pending = false;
	for (const tx of scan.txs) {
		if (tx.height <= 0) pending = true;
		else if (tx.time != null) latest = Math.max(latest ?? 0, tx.time);
	}
	if (pending) return Math.floor(Date.now() / 1000);
	return latest;
}

export function toMultisigSummary(
	multisig: MultisigRow,
	scan?: MultisigScanResult,
	share?: { role: ShareRole; sharedBy: string }
): MultisigSummary {
	return {
		id: multisig.id,
		name: multisig.name,
		threshold: multisig.threshold,
		totalKeys: multisig.keys.length,
		scriptType: multisig.scriptType,
		createdAt: multisig.createdAt,
		balance: scan?.confirmed ?? 0,
		unconfirmed: scan?.unconfirmed ?? 0,
		lastActivity: scan ? lastActivityOf(scan) : null,
		role: share?.role ?? 'owner',
		sharedBy: share?.sharedBy ?? null
	};
}

/**
 * All multisigs the user can see — the ones they own PLUS the ones shared with
 * them as a viewer/cosigner (collaborative custody) — with live balances from
 * (cached) scans. A scan failure never throws: that multisig comes back with
 * zeroed balances and its error message lands in `errors[multisigId]`.
 */
export async function listMultisigSummaries(
	userId: number
): Promise<{ multisigs: MultisigSummary[]; errors: Record<number, string> }> {
	const errors: Record<number, string> = {};

	const summarize = async (
		row: MultisigRow,
		share?: { role: ShareRole; sharedBy: string }
	): Promise<MultisigSummary> => {
		try {
			return toMultisigSummary(row, await scanMultisig(row), share);
		} catch (e) {
			errors[row.id] = e instanceof Error ? e.message : 'Multisig scan failed';
			return toMultisigSummary(row, undefined, share);
		}
	};

	const owned = await Promise.all(listMultisigs(userId).map((row) => summarize(row)));

	// Wallets shared WITH this user. Load each full row through the viewable gate
	// (skip any share whose wallet vanished in a race) so its keys/balance render
	// exactly like an owned wallet, just tagged with the share role and owner.
	const shared = await Promise.all(
		listSharedMultisigs(userId).map(async (s) => {
			const row = getViewableMultisig(userId, s.multisigId);
			if (!row) return null;
			return summarize(row, { role: s.role, sharedBy: s.ownerName });
		})
	);

	return { multisigs: [...owned, ...shared.filter((s): s is MultisigSummary => s !== null)], errors };
}
