// UTXO signing-mass estimator core (bead cairn-194) — the PURE, environment-
// neutral half of the feature: device timing profiles, tier thresholds, and
// the time-estimation math, with NO server-only dependency (no network, no
// caching, no in-process state). It lives under $lib (not $lib/server) so both
// the server module (src/lib/server/bitcoin/signingMass.ts) and client code
// (the multisig send page's local mass summary) import the SAME constants and
// arithmetic instead of restating them.
//
// Background — why signing "mass" exists:
//
// Hardware wallets verify each input's amount by importing the input's FULL
// parent transaction — the nonWitnessUtxo Cairn attaches to every PSBT input.
// When a coin descends from a mining-pool payout, that parent is enormous
// (field data via Unchained's research):
//
//     F2Pool    ~2500–5500 outputs per payout batch
//     ViaBTC    ~1400–1600 outputs
//     Foundry   ~200–250 outputs
//     P2P send  1–3 outputs
//
// Every one of those output scripts must be streamed to — and hashed by — the
// signing device so it can verify the parent's txid, which makes device
// signing time roughly proportional to total parent-transaction size. Trezor
// is the most affected: it streams and hashes every referenced transaction
// chunk-by-chunk over USB. This "mass" affects SIGNING TIME ONLY — never
// network fees, which depend on the size of the transaction being BUILT, not
// of its parents. And it matters per-signer: in an M-of-N multisig, each of the
// M signing devices independently processes the full mass.

export type MassTier = 'low' | 'medium' | 'high';
export type ParentSource = 'pool-batch' | 'batch' | 'p2p' | 'unknown';
export type SignerDevice = 'trezor' | 'ledger' | 'coldcard';

export interface ParentClassification {
	/** Virtual size of the parent transaction (weight/4, rounded up). */
	vsize: number;
	outputCount: number;
	source: ParentSource;
}

export interface SigningMass {
	/** Sum of parent-tx vsizes across the spend's UNIQUE parents. */
	totalParentVsize: number;
	tier: MassTier;
	/** PER-SIGNER estimates: what one device of each kind would take. */
	perDevice: { device: SignerDevice; secondsLo: number; secondsHi: number }[];
	/** True when timeout risk is real AND splitting the spend would actually help. */
	splitSuggested: boolean;
	/**
	 * Whole-ceremony estimate: per-signer time × the quorum M (M = 1 for
	 * single-sig wallets). The device mix in a multisig is unknown, so this
	 * brackets with the fastest device's low bound and the slowest device's
	 * high bound.
	 */
	totalSeconds: { lo: number; hi: number };
	/** 'amber' past 10 min total, 'red' past 30 min total or on single-device
	 *  timeout risk (see warnLevelFor). */
	warnLevel: 'none' | 'amber' | 'red';
}

// -------------------------------------------------------------------- tiers
//
// Thresholds are HEURISTICS, tuned so the archetypes land where a user would
// expect (all sizes are parent-tx vsize; a payout output costs ~31 vB for
// p2wpkh up to ~43 vB for p2tr, so per-pool ranges are wide):
//
//     P2P parent          1–3 outputs        ~110–400 vB      → low
//     Foundry payout      ~200–250 outputs   ~6.5k–11k vB     → medium
//     ViaBTC payout       ~1400–1600 outputs ~44k–69k vB      → high
//     F2Pool payout       ~2500–5500 outputs ~78k–237k vB     → firmly high
//
// The medium line sits at 8k vB so mid-range Foundry payouts cross it, and
// the high line at 40k vB so every ViaBTC/F2Pool-class parent lands high
// while a lone Foundry parent never does. (An earlier draft used 25k/100k,
// but at those lines Foundry classified low and ViaBTC medium — the wrong
// user-facing story for both.) On a worst-case Trezor stream (~1.5 kvB/s,
// see DEVICE_PROFILES) 40k vB is ~27 s of parent streaming per signer:
// exactly where "noticeably slow" starts.
export const TIER_MEDIUM_VSIZE = 8_000; // low < this
export const TIER_HIGH_VSIZE = 40_000; // high > this

export function tierForVsize(totalVsize: number): MassTier {
	if (totalVsize < TIER_MEDIUM_VSIZE) return 'low';
	if (totalVsize <= TIER_HIGH_VSIZE) return 'medium';
	return 'high';
}

// ------------------------------------------------------- source heuristic
//
// Source heuristic, anchored on the pool payout stats above. Foundry's
// ~200–250-output payouts are the SMALLEST of the big-pool batches, so 200+
// outputs is safely "pool-batch or similar industrial batcher" territory;
// 20+ is some kind of batch payer (exchange withdrawal batching, smaller
// pools); 1–5 outputs is an ordinary P2P transaction; the 6–19 gap is
// genuinely ambiguous, so it stays 'unknown' rather than guessing.
export const POOL_BATCH_MIN_OUTPUTS = 200;
export const BATCH_MIN_OUTPUTS = 20;
export const P2P_MAX_OUTPUTS = 5;

/** Origin heuristic from a parent's output count. */
export function classifyParentSource(outputCount: number): ParentSource {
	return outputCount >= POOL_BATCH_MIN_OUTPUTS
		? 'pool-batch'
		: outputCount >= BATCH_MIN_OUTPUTS
			? 'batch'
			: outputCount <= P2P_MAX_OUTPUTS
				? 'p2p'
				: 'unknown';
}

// --------------------------------------------------------- time estimation
//
// ORDER-OF-MAGNITUDE estimates, not measurements. The model per signer:
//
//     seconds = base + inputCount × perInput × keyFactor + parentVsize / rate
//
//   base       device session overhead (connect, PSBT load, confirm screens)
//   perInput   per-input parse/display work, scaled by keyFactor because an
//              M-of-N input carries an N-key witness/redeem script (34 bytes
//              per key) plus N bip32Derivation entries the device must parse
//              — a minor factor, modeled as +15% per key beyond the first
//   rate       parent-transaction streaming/hashing throughput in vB/s; the
//              dominant term for pool-payout parents
//
// Device character: Trezor streams every referenced transaction over USB in
// small chunks and hashes it on-device — slowest by far on large parents.
// Ledger also verifies prevouts but with a faster transport/parser. Coldcard
// ingests the whole PSBT (SD/USB) and hashes at MCU speed. The lo bound uses
// the optimistic rate, the hi bound the pessimistic one.
//
// TODO: calibrate against real hardware — the e2e harness (scripts/vault-e2e)
// drives a Trezor emulator end-to-end and can measure actual signing times
// for synthetic pool-sized parents; replace these constants with measured
// curves once that run exists.
export const DEVICE_PROFILES: Record<
	SignerDevice,
	{
		baseLo: number;
		baseHi: number;
		perInputLo: number;
		perInputHi: number;
		/** Optimistic parent-streaming rate, vB/s (used for the LOW bound). */
		rateFast: number;
		/** Pessimistic parent-streaming rate, vB/s (used for the HIGH bound). */
		rateSlow: number;
	}
> = {
	trezor: { baseLo: 3, baseHi: 8, perInputLo: 0.5, perInputHi: 1.5, rateFast: 8_000, rateSlow: 1_500 },
	ledger: { baseLo: 2, baseHi: 5, perInputLo: 0.3, perInputHi: 1.0, rateFast: 20_000, rateSlow: 6_000 },
	coldcard: { baseLo: 2, baseHi: 6, perInputLo: 0.2, perInputHi: 0.8, rateFast: 35_000, rateSlow: 10_000 }
};

export const SIGNER_DEVICES: SignerDevice[] = ['trezor', 'ledger', 'coldcard'];

/** Per-input work multiplier for an N-key script: +15% per key past the first. */
export const KEYS_PER_INPUT_FACTOR = 0.15;

export interface SigningSecondsParams {
	totalParentVsize: number;
	inputCount: number;
	/** Quorum M — how many signers must each process the full mass. Absent = single-sig (1). */
	threshold?: number;
	/** Total keys N in the script — scales per-input parsing work. Absent = single-sig (1). */
	totalKeys?: number;
	device: SignerDevice;
}

function keyFactor(totalKeys: number | undefined): number {
	return 1 + KEYS_PER_INPUT_FACTOR * Math.max(0, (totalKeys ?? 1) - 1);
}

/** One signer's estimated seconds on `device` — UNROUNDED, quorum NOT applied. */
export function perSignerSeconds(
	device: SignerDevice,
	totalParentVsize: number,
	inputCount: number,
	totalKeys?: number
): { lo: number; hi: number } {
	const p = DEVICE_PROFILES[device];
	const kf = keyFactor(totalKeys);
	return {
		lo: p.baseLo + inputCount * p.perInputLo * kf + totalParentVsize / p.rateFast,
		hi: p.baseHi + inputCount * p.perInputHi * kf + totalParentVsize / p.rateSlow
	};
}

function roundSeconds(x: number): number {
	return Math.max(1, Math.round(x));
}

/**
 * PURE whole-ceremony estimate for one device kind: per-signer seconds × the
 * quorum M (every one of the M signers independently streams and hashes the
 * full parent mass — the work is not shared). threshold/totalKeys absent
 * means single-sig. This is the function the multisig surfaces (send flow,
 * creation wizard) call directly.
 */
export function estimateSigningSeconds(params: SigningSecondsParams): {
	secondsLo: number;
	secondsHi: number;
} {
	const m = Math.max(1, params.threshold ?? 1);
	const per = perSignerSeconds(
		params.device,
		params.totalParentVsize,
		params.inputCount,
		params.totalKeys
	);
	return { secondsLo: roundSeconds(per.lo * m), secondsHi: roundSeconds(per.hi * m) };
}

/**
 * Whole-ceremony bracket when the device mix is unknown: best case everyone
 * signs on the fastest device (min lo), worst case everyone on the slowest
 * (max hi).
 */
export function quorumSecondsRange(params: Omit<SigningSecondsParams, 'device'>): {
	lo: number;
	hi: number;
} {
	let lo = Infinity;
	let hi = 0;
	for (const device of SIGNER_DEVICES) {
		const est = estimateSigningSeconds({ ...params, device });
		lo = Math.min(lo, est.secondsLo);
		hi = Math.max(hi, est.secondsHi);
	}
	return { lo, hi };
}

// ------------------------------------------------------------- warn levels
//
// warnLevel keys off the CONSERVATIVE (hi) whole-ceremony estimate: amber
// past 10 minutes, red past 30. Red also fires on single-device timeout
// risk regardless of quorum: a Trezor worst-case stream beyond ~90 s of
// continuous refTx hashing is where Trezor Connect sessions, bridge
// round-trips, and users themselves start aborting — per the tier reasoning
// above that corresponds to roughly >130k vB of parent mass (deep in the
// 'high' tier, F2Pool-payout territory), so 'red' here always implies a
// high-tier mass but not vice versa.
export const AMBER_TOTAL_SECONDS = 600;
export const RED_TOTAL_SECONDS = 1_800;
export const TREZOR_TIMEOUT_RISK_SECONDS = 90;

export function warnLevelFor(
	totalSeconds: { lo: number; hi: number },
	trezorPerSignerHi: number
): SigningMass['warnLevel'] {
	if (totalSeconds.hi > RED_TOTAL_SECONDS) return 'red';
	if (trezorPerSignerHi > TREZOR_TIMEOUT_RISK_SECONDS) return 'red';
	if (totalSeconds.hi > AMBER_TOTAL_SECONDS) return 'amber';
	return 'none';
}

// ---------------------------------------------------------- mass assembly

/**
 * A parent counts as individually heavy for split purposes at the medium
 * line: past it, moving that parent's coins to their own transaction changes
 * the child's tier story.
 */
export const SPLIT_PARENT_VSIZE = TIER_MEDIUM_VSIZE;

export interface ComputeSigningMassParams {
	/** vsize of each UNIQUE parent transaction backing the spend's inputs. */
	parentVsizes: number[];
	/** Inputs being spent (several can share one parent). */
	inputCount: number;
	/** Quorum M; absent = single-sig. */
	threshold?: number;
	/** Total keys N; absent = single-sig. */
	totalKeys?: number;
}

/**
 * Assemble the full signingMass block from per-unique-parent vsizes.
 *
 * splitSuggested: only when the tier is 'high' AND more than one
 * individually-heavy parent contributes. Splitting a spend into several
 * transactions only helps when the mass is DIVISIBLE — every child
 * transaction still carries the full parent of each input it spends, so a
 * single F2Pool-sized parent weighs on any transaction that touches its
 * coins no matter how the spend is split. Two or more heavy parents, though,
 * can go to separate transactions, halving (or better) each signing
 * session's mass.
 */
export function computeSigningMass(params: ComputeSigningMassParams): SigningMass {
	const totalParentVsize = params.parentVsizes.reduce((s, v) => s + v, 0);
	const tier = tierForVsize(totalParentVsize);
	const quorum = {
		totalParentVsize,
		inputCount: params.inputCount,
		threshold: params.threshold,
		totalKeys: params.totalKeys
	};
	const perDevice = SIGNER_DEVICES.map((device) => ({
		device,
		// Per-signer view: quorum deliberately not applied here.
		...estimateSigningSeconds({ ...quorum, threshold: 1, device })
	}));
	const totalSeconds = quorumSecondsRange(quorum);
	const heavyParents = params.parentVsizes.filter((v) => v >= SPLIT_PARENT_VSIZE).length;
	return {
		totalParentVsize,
		tier,
		perDevice,
		splitSuggested: tier === 'high' && heavyParents > 1,
		totalSeconds,
		warnLevel: warnLevelFor(
			totalSeconds,
			perSignerSeconds('trezor', totalParentVsize, params.inputCount, params.totalKeys).hi
		)
	};
}

// ----------------------------------------------- wallet mass profile types
//
// Type + pure sampling helpers used by the signing-time preview. The remembering
// store itself is in-process state and stays server-side.

export interface UtxoMassProfileEntry {
	txid: string;
	value: number; // sats
	parentVsize: number;
}

/**
 * Reduce a mass profile to a plausible spend: the top `maxInputs` UTXOs by
 * VALUE — larger coins dominate real spends (both Cairn's selector and
 * btc-signer's 'default' strategy pick biggest-first), so they are the
 * likely input set. Parent vsizes are summed over UNIQUE parents, matching
 * how signingMass counts them.
 */
export function sampleLikelySpend(
	entries: UtxoMassProfileEntry[],
	maxInputs = 6
): { totalParentVsize: number; inputCount: number } {
	const top = [...entries].sort((a, b) => b.value - a.value).slice(0, maxInputs);
	const seen = new Set<string>();
	let totalParentVsize = 0;
	for (const e of top) {
		if (seen.has(e.txid)) continue;
		seen.add(e.txid);
		totalParentVsize += e.parentVsize;
	}
	return { totalParentVsize, inputCount: top.length };
}

/**
 * Fallback spend profile when nothing about the user's coins is cached yet:
 * a handful of ordinary P2P-funded inputs (each parent 1–3 outputs, a few
 * hundred vB) — the typical non-pool wallet.
 */
export const TYPICAL_SPEND_PROFILE = { totalParentVsize: 900, inputCount: 3 } as const;
