// Multisig scanning: gap-limit address discovery over Electrum for M-of-N
// multisig multisigs. A multisig's p2wsh addresses hash to scripthashes exactly like
// single-sig addresses, so this mirrors walletScan.ts's BIP44-style discovery
// (same gap limit, batching, caching) with derivation swapped for
// deriveMultisigAddress over the multisig's key set.
//
// Contract consumed by the multisig send flow (do not rename):
//   getMultisigUtxos(multisig)      → Promise<SpendableUtxo[]>
//   getMultisigDetail(multisig)     → { balance: {confirmed, unconfirmed}, utxos,
//                                 addresses: {address, chain, index, used}[],
//                                 history }
//   nextMultisigChangeIndex(multisig) → first unused change index

import { bytesToHex } from '@noble/hashes/utils.js';
import { deriveMultisigAddress, multisigToDescriptor } from './bitcoin/multisig';
import { addressToScripthash } from './bitcoin/xpub';
import { getChain } from './chain/index';
import type { ElectrumBalance, ElectrumHistoryItem } from './electrum/client';
import type { SpendableUtxo } from './bitcoin/psbt';
import { toMultisigConfig, bumpReceiveCursor, listMultisigs, type MultisigRow } from './wallets/multisig';

const GAP_LIMIT = 20;
const BATCH_SIZE = 20;
const HARD_CAP = 400; // per chain (receive / change)
const TX_DETAIL_CAP = 50;
const TX_FETCH_CONCURRENCY = 8;
const CACHE_TTL_MS = 60_000;

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

interface ScannedAddress extends MultisigScanAddress {
	history: ElectrumHistoryItem[];
	confirmedSats: number;
	unconfirmedSats: number;
}

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

async function scanChainOf(multisig: MultisigRow, chain: 0 | 1): Promise<ScannedAddress[]> {
	const chainSvc = getChain();
	const out: ScannedAddress[] = [];
	let consecutiveUnused = 0;
	let index = 0;

	while (consecutiveUnused < GAP_LIMIT && index < HARD_CAP) {
		const batch: { address: string; index: number }[] = [];
		for (let i = 0; i < BATCH_SIZE && index + i < HARD_CAP; i++) {
			batch.push({ address: multisigAddressAt(multisig, chain, index + i), index: index + i });
		}
		const scripthashes = batch.map((b) => addressToScripthash(b.address));

		const [histories, balances] = await Promise.all([
			chainSvc.electrum.batchRequest(
				scripthashes.map((sh) => ({ method: 'blockchain.scripthash.get_history', params: [sh] }))
			) as Promise<ElectrumHistoryItem[][]>,
			chainSvc.electrum.batchRequest(
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
				chain,
				index: batch[i].index,
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

async function collectMultisigTxs(scanned: ScannedAddress[]): Promise<MultisigTx[]> {
	const chainSvc = getChain();
	const multisigAddresses = new Set(scanned.map((a) => a.address));

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

	const txs: MultisigTx[] = [];
	for (let i = 0; i < recent.length; i += TX_FETCH_CONCURRENCY) {
		const chunk = recent.slice(i, i + TX_FETCH_CONCURRENCY);
		const results = await Promise.all(
			chunk.map(async ([txid, height]): Promise<MultisigTx | null> => {
				try {
					const tx = await chainSvc.getTx(txid);
					let delta = 0;
					for (const out of tx.vout) {
						if (out.address && multisigAddresses.has(out.address)) delta += out.value;
					}
					for (const vin of tx.vin) {
						if (!vin.coinbase && vin.address && multisigAddresses.has(vin.address)) {
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

async function doScan(multisig: MultisigRow): Promise<MultisigScanResult & { scanned: ScannedAddress[] }> {
	const [receive, change] = await Promise.all([scanChainOf(multisig, 0), scanChainOf(multisig, 1)]);
	const scanned = [...receive, ...change];

	const txs = await collectMultisigTxs(scanned);

	let confirmed = 0;
	let unconfirmed = 0;
	for (const a of scanned) {
		confirmed += a.confirmedSats;
		unconfirmed += a.unconfirmedSats;
	}

	const addresses: MultisigScanAddress[] = scanned.map(
		({ history: _h, confirmedSats: _c, unconfirmedSats: _u, ...addr }) => addr
	);
	return { addresses, txs, confirmed, unconfirmed, scanned };
}

// ---------------------------------------------------------------------- cache

// Keyed on the multisig's receive descriptor: it captures the full key set,
// threshold, and script type, so any config difference is a different cache
// entry (and two multisigs with identical configs share one scan — correctly,
// since they'd share addresses too).
const scanCache = new Map<
	string,
	{ expires: number; promise: Promise<MultisigScanResult & { scanned: ScannedAddress[] }> }
>();

function cacheKey(multisig: MultisigRow): string {
	return multisigToDescriptor(toMultisigConfig(multisig));
}

/** Scan a multisig over Electrum. Results are cached in-process for 60s. */
export function scanMultisig(multisig: MultisigRow): Promise<MultisigScanResult> {
	const key = cacheKey(multisig);
	const now = Date.now();
	const hit = scanCache.get(key);
	if (hit && hit.expires > now) return hit.promise;

	const promise = doScan(multisig);
	scanCache.set(key, { expires: now + CACHE_TTL_MS, promise });
	promise.catch(() => {
		// Never cache failures (and never leave an unhandled rejection).
		if (scanCache.get(key)?.promise === promise) scanCache.delete(key);
	});
	return promise;
}

/** Drop cached scan results for one multisig, or all when omitted. */
export function invalidateMultisigCache(multisig?: MultisigRow): void {
	if (multisig === undefined) scanCache.clear();
	else scanCache.delete(cacheKey(multisig));
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
	return results.flat();
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

export function toMultisigSummary(multisig: MultisigRow, scan?: MultisigScanResult): MultisigSummary {
	return {
		id: multisig.id,
		name: multisig.name,
		threshold: multisig.threshold,
		totalKeys: multisig.keys.length,
		scriptType: multisig.scriptType,
		createdAt: multisig.createdAt,
		balance: scan?.confirmed ?? 0,
		unconfirmed: scan?.unconfirmed ?? 0,
		lastActivity: scan ? lastActivityOf(scan) : null
	};
}

/**
 * All multisigs for a user, with live balances from (cached) scans.
 * A scan failure never throws: that multisig comes back with zeroed balances
 * and its error message lands in `errors[multisigId]`.
 */
export async function listMultisigSummaries(
	userId: number
): Promise<{ multisigs: MultisigSummary[]; errors: Record<number, string> }> {
	const rows = listMultisigs(userId);
	const errors: Record<number, string> = {};
	const multisigs = await Promise.all(
		rows.map(async (row) => {
			try {
				const scan = await scanMultisig(row);
				return toMultisigSummary(row, scan);
			} catch (e) {
				errors[row.id] = e instanceof Error ? e.message : 'Multisig scan failed';
				return toMultisigSummary(row);
			}
		})
	);
	return { multisigs, errors };
}
