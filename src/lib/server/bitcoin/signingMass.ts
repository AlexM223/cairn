// UTXO signing-mass awareness (bead cairn-194) — SERVER side.
//
// The pure estimator core (device timing profiles, tier thresholds, the
// time-estimation math, and the signingMass assembly) now lives in the
// environment-neutral module $lib/shared/signingMass so client code (the
// multisig send page's local mass summary) can share the EXACT same constants
// and arithmetic — $lib/server is server-only and cannot be imported into the
// client bundle. This module keeps the server-only half: raw-parent parsing,
// the in-process classification cache, the wallet-mass-profile store, and the
// construction/selection helpers that lean on them. It re-exports the shared
// core so existing server importers (and the test) keep their single import
// site.
//
// Hardware wallets verify each input's amount by importing the input's FULL
// parent transaction — the nonWitnessUtxo Cairn already attaches to every
// PSBT input. When a coin descends from a mining-pool payout, that parent is
// enormous (field data via Unchained's research):
//
//     F2Pool    ~2500–5500 outputs per payout batch
//     ViaBTC    ~1400–1600 outputs
//     Foundry   ~200–250 outputs
//     P2P send  1–3 outputs
//
// Every one of those output scripts must be streamed to — and hashed by —
// the signing device so it can verify the parent's txid, which makes device
// signing time roughly proportional to total parent-transaction size. Trezor
// is the most affected: it streams and hashes every referenced transaction
// chunk-by-chunk over USB. This "mass" affects SIGNING TIME ONLY — never
// network fees, which depend on the size of the transaction being BUILT, not
// of its parents. And it matters per-signer: in an M-of-N multisig, each of the
// M signing devices independently processes the full mass.

import { Transaction } from '@scure/btc-signer';
import { hexToBytes } from '@noble/hashes/utils.js';
import {
	classifyParentSource,
	computeSigningMass,
	TIER_MEDIUM_VSIZE
} from '$lib/shared/signingMass';
import type { ParentClassification, SigningMass, UtxoMassProfileEntry } from '$lib/shared/signingMass';

// Re-export the pure estimator core so this module remains the single import
// site for every existing server consumer and the test suite.
export {
	tierForVsize,
	estimateSigningSeconds,
	quorumSecondsRange,
	computeSigningMass,
	warnLevelFor,
	perSignerSeconds,
	sampleLikelySpend,
	classifyParentSource,
	POOL_BATCH_MIN_OUTPUTS,
	BATCH_MIN_OUTPUTS,
	P2P_MAX_OUTPUTS,
	TIER_MEDIUM_VSIZE,
	TIER_HIGH_VSIZE,
	DEVICE_PROFILES,
	SIGNER_DEVICES,
	KEYS_PER_INPUT_FACTOR,
	AMBER_TOTAL_SECONDS,
	RED_TOTAL_SECONDS,
	TREZOR_TIMEOUT_RISK_SECONDS,
	SPLIT_PARENT_VSIZE,
	TYPICAL_SPEND_PROFILE
} from '$lib/shared/signingMass';
export type {
	MassTier,
	ParentSource,
	SignerDevice,
	ParentClassification,
	SigningMass,
	SigningSecondsParams,
	ComputeSigningMassParams,
	UtxoMassProfileEntry
} from '$lib/shared/signingMass';

// ------------------------------------------------------------------- parsing

const RAW_TX_OPTS = {
	allowUnknownInputs: true,
	allowUnknownOutputs: true,
	disableScriptCheck: true
} as const;

function toBytes(rawTx: string | Uint8Array): Uint8Array {
	return typeof rawTx === 'string' ? hexToBytes(rawTx.trim()) : rawTx;
}

/**
 * Parse a raw transaction and compute its virtual size: weight / 4, rounded
 * up (BIP-141), with weight = base_size × 3 + total_size. Computed from the
 * two serializations directly rather than btc-signer's `.weight` getter,
 * which refuses non-finalized transactions (synthetic test parents built
 * without signatures would throw there; mined parents are always final, but
 * the direct formula covers both identically).
 */
export function parentVsizeFromRawTx(rawTx: string | Uint8Array): number {
	const tx = Transaction.fromRaw(toBytes(rawTx), RAW_TX_OPTS);
	const baseSize = tx.toBytes(true, false).length;
	const totalSize = tx.hasWitnesses ? tx.toBytes(true, true).length : baseSize;
	return Math.ceil((baseSize * 3 + totalSize) / 4);
}

/** Parse a raw parent tx into its vsize, output count, and origin heuristic. */
export function classifyParent(rawTx: string | Uint8Array): ParentClassification {
	const bytes = toBytes(rawTx);
	const tx = Transaction.fromRaw(bytes, RAW_TX_OPTS);
	const outputCount = tx.outputsLength;
	return {
		vsize: parentVsizeFromRawTx(bytes),
		outputCount,
		source: classifyParentSource(outputCount)
	};
}

// ------------------------------------------------------------------- cache
//
// In-process parent-classification cache, keyed by txid. Mirrors the style
// of psbt.ts's rawPrevTx caching but process-wide: confirmed parents are
// immutable, so entries never go stale — the only bound needed is size.
// Stores the small classification (not raw bytes), evicting the
// least-recently-USED entry past the cap; 512 distinct parents comfortably
// covers every wallet's coin-control view plus construction traffic.

export const PARENT_MASS_CACHE_MAX = 512;

const parentMassCache = new Map<string, ParentClassification>();

/** Cached classification for a parent txid, or undefined. Refreshes recency. */
export function getCachedParentMass(txid: string): ParentClassification | undefined {
	const hit = parentMassCache.get(txid);
	if (hit) {
		// Map iterates in insertion order — re-insert to mark as recently used.
		parentMassCache.delete(txid);
		parentMassCache.set(txid, hit);
	}
	return hit;
}

/** Classify a raw parent tx and cache the result under its txid. */
export function classifyAndCacheParent(
	txid: string,
	rawTx: string | Uint8Array
): ParentClassification {
	const hit = getCachedParentMass(txid);
	if (hit) return hit;
	const classified = classifyParent(rawTx);
	parentMassCache.set(txid, classified);
	while (parentMassCache.size > PARENT_MASS_CACHE_MAX) {
		const oldest = parentMassCache.keys().next().value;
		if (oldest === undefined) break;
		parentMassCache.delete(oldest);
	}
	return classified;
}

export function parentMassCacheSize(): number {
	return parentMassCache.size;
}

/** Test hook: drop every cached parent (and remembered wallet profiles). */
export function clearParentMassCache(): void {
	parentMassCache.clear();
	walletMassProfiles.clear();
}

// ------------------------------------------------- construction-side helper

/**
 * signingMass for a set of chosen inputs, computed ONLY from parents already
 * fetched during construction (the prevTx map both PSBT builders keep for
 * nonWitnessUtxo) — mass computation never adds network round trips and
 * NEVER fails construction.
 *
 * Degrade rule: if ANY chosen input's parent is missing from the map (no
 * fetchRawTx was provided, or a segwit build skipped fetching), the whole
 * block is omitted (undefined) rather than computed over a partial parent
 * set — an understated mass is false confidence, and the UI showing nothing
 * is strictly better. Same for any unexpected parse failure.
 */
export function signingMassFromFetchedParents(
	inputs: { txid: string }[],
	fetchedParents: ReadonlyMap<string, Uint8Array>,
	quorum?: { threshold: number; totalKeys: number }
): SigningMass | undefined {
	try {
		const parentVsizes: number[] = [];
		const seen = new Set<string>();
		for (const { txid } of inputs) {
			if (seen.has(txid)) continue; // unique parents only
			seen.add(txid);
			const cached = getCachedParentMass(txid);
			if (cached) {
				parentVsizes.push(cached.vsize);
				continue;
			}
			const raw = fetchedParents.get(txid);
			if (!raw) return undefined; // unknown parent → omit entirely
			parentVsizes.push(classifyAndCacheParent(txid, raw).vsize);
		}
		if (parentVsizes.length === 0) return undefined;
		return computeSigningMass({
			parentVsizes,
			inputCount: inputs.length,
			threshold: quorum?.threshold,
			totalKeys: quorum?.totalKeys
		});
	} catch {
		return undefined;
	}
}

// -------------------------------------------------- selection-order bias

/**
 * Best-effort low-mass bias for coin selection: a stable re-sort of the
 * candidate UTXOs by their parent's CACHED mass, ascending, before they are
 * handed to the selector. Never fetches a parent (selection must not gain
 * latency) — coins whose parents aren't cached yet get a neutral middle
 * weight so known-light coins still sort ahead of them and known-heavy ones
 * behind.
 *
 * Fee/amount neutrality: btc-signer's 'default' strategy re-sorts candidates
 * by VALUE internally, so this ordering can only influence the choice
 * between equal-value coins (JS sorts are stable) — it biases ties toward
 * low-mass parents and can never change fees or amounts.
 */
export function preferLowMassOrder<T extends { txid: string }>(utxos: T[]): T[] {
	const key = (u: T) => getCachedParentMass(u.txid)?.vsize ?? TIER_MEDIUM_VSIZE;
	return [...utxos].sort((a, b) => key(a) - key(b));
}

// ------------------------------------------- wallet mass profiles (preview)
//
// The multisig-creation wizard's signing-time preview compares quorums against
// the user's ACTUAL coins when possible. Whenever the utxo-mass endpoint
// classifies a wallet's coins it remembers a tiny (value, parentVsize)
// profile here; the preview aggregates those profiles instead of touching
// the network (it must be instant — cache-or-typical only, never a fetch).

const WALLET_PROFILE_CACHE_MAX = 128;
const walletMassProfiles = new Map<string, { userId: number; entries: UtxoMassProfileEntry[] }>();

export function rememberWalletMassProfile(
	userId: number,
	walletId: number,
	entries: UtxoMassProfileEntry[]
): void {
	const key = `${userId}:${walletId}`;
	walletMassProfiles.delete(key);
	walletMassProfiles.set(key, { userId, entries });
	while (walletMassProfiles.size > WALLET_PROFILE_CACHE_MAX) {
		const oldest = walletMassProfiles.keys().next().value;
		if (oldest === undefined) break;
		walletMassProfiles.delete(oldest);
	}
}

/** Every remembered UTXO-mass entry across a user's wallets (may be []). */
export function getUserMassProfile(userId: number): UtxoMassProfileEntry[] {
	const out: UtxoMassProfileEntry[] = [];
	for (const profile of walletMassProfiles.values()) {
		if (profile.userId === userId) out.push(...profile.entries);
	}
	return out;
}
