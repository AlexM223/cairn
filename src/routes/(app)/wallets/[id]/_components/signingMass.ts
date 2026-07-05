/**
 * Client-side vocabulary for UTXO "signing mass" — how big each coin's PARENT
 * transaction is. Hardware wallets import an input's full parent transaction
 * to verify its amount, so coins born in enormous batch payouts (mining-pool
 * payout runs with thousands of outputs) take much longer to sign — minutes,
 * sometimes long enough for the device to time out.
 *
 * Mass affects SIGNING TIME ONLY. It never changes the network fee, and the
 * coins are exactly as safe to spend as any other. Every piece of copy built
 * from this module must keep that distinction.
 *
 * Server contract mirrored here (fields optional/absent = unknown → show
 * nothing): build responses carry `signingMass`; GET
 * /api/wallets/[id]/utxo-mass returns per-coin masses.
 */

// Type-only imports of the server's canonical definitions — erased at compile
// time (same idiom as the send page importing ConstructedPsbt), so nothing
// server-only ever reaches the client bundle and the shapes cannot drift.
import type {
	SigningMass,
	MassTier,
	ParentSource,
	SignerDevice
} from '$lib/server/bitcoin/signingMass';

export type { SigningMass, MassTier };
export type MassSource = ParentSource;
export type MassWarnLevel = SigningMass['warnLevel'];
export type MassDevice = SignerDevice;

/** One coin's parent-transaction mass, from GET /api/wallets/[id]/utxo-mass. */
export interface UtxoMass {
	txid: string;
	vout: number;
	parentVsize: number;
	tier: MassTier;
	source: MassSource;
}

export interface UtxoMassResponse {
	masses: UtxoMass[];
}

export const DEVICE_LABELS: Record<MassDevice, string> = {
	trezor: 'Trezor',
	ledger: 'Ledger',
	coldcard: 'ColdCard'
};

// ------------------------------------------------------------------- copy
// Shared plain-language strings so every surface says the same thing.

/** Legend shown wherever high-mass coins are listed. */
export const MASS_LEGEND =
	"Some of these coins came from large batch payouts. They're safe to spend, but hardware wallets take longer to sign them.";

/** The one-sentence mass ≠ fees distinction — the required educational line. */
export const MASS_NOT_FEES_TIP =
	"Signing time depends on where the coins came from; the network fee doesn't.";

/** Fuller tooltip: the why, ending with the mass ≠ fees sentence. */
export const MASS_WHY_TIP =
	'Hardware wallets read each coin’s full parent transaction to verify its amount. Coins from huge batch payouts — like mining-pool payout runs — have huge parents, so signing takes longer. ' +
	MASS_NOT_FEES_TIP;

/** Per-coin chip: label (visible), tone (styling), title (hover detail). */
export function massChip(m: UtxoMass): { label: string; tone: MassTier; title: string } {
	if (m.tier === 'high') {
		const label =
			m.source === 'pool-batch'
				? 'Mining pool payout — slow to sign'
				: m.source === 'batch'
					? 'Batch payment — slow to sign'
					: 'Slow to sign';
		return {
			label,
			tone: 'high',
			title:
				'This coin came from a very large transaction. Your hardware wallet reads that whole transaction to verify the amount, so signing can take minutes. The network fee is not affected.'
		};
	}
	if (m.tier === 'medium') {
		return {
			label: 'Slower to sign',
			tone: 'medium',
			title:
				'This coin’s parent transaction is on the large side — signing takes a bit longer on a hardware wallet. The network fee is not affected.'
		};
	}
	return {
		label: 'Fast',
		tone: 'low',
		title: 'Fast to sign — this coin came from a small transaction.'
	};
}

// ------------------------------------------------------------- formatting

/**
 * Humane duration range: minutes when the top of the range clears 90 seconds,
 * plain seconds below that. Equal ends collapse to a single value.
 * "short" → "~3-6 min" · "long" → "~3-6 minutes" (for headlines).
 */
export function formatSigningRange(
	loSeconds: number,
	hiSeconds: number,
	style: 'short' | 'long' = 'short'
): string {
	const lo = Math.max(0, loSeconds);
	const hi = Math.max(lo, hiSeconds);
	if (hi > 90) {
		const unit = style === 'long' ? 'minutes' : 'min';
		const lm = Math.max(1, Math.round(lo / 60));
		const hm = Math.max(lm, Math.round(hi / 60));
		if (lm === hm) return `~${lm} ${style === 'long' ? (lm === 1 ? 'minute' : 'minutes') : unit}`;
		return `~${lm}–${hm} ${unit}`;
	}
	const unit = style === 'long' ? 'seconds' : 'sec';
	const round5 = (s: number) => Math.max(5, Math.round(s / 5) * 5);
	const ls = round5(lo);
	const hs = Math.max(ls, round5(hi));
	if (ls === hs) return `~${ls} ${unit}`;
	return `~${ls}–${hs} ${unit}`;
}

/** "Trezor: ~3-6 min · Ledger: ~1-2 min · ColdCard: ~2-4 min" */
export function perDeviceLine(perDevice: SigningMass['perDevice']): string {
	return perDevice
		.map((d) => `${DEVICE_LABELS[d.device] ?? d.device}: ${formatSigningRange(d.secondsLo, d.secondsHi)}`)
		.join(' · ');
}

// ---------------------------------------------------------------- fetching

/** Lazy per-coin mass lookup. Null = unknown (endpoint missing, offline, …) — callers show nothing. */
export async function fetchUtxoMass(walletId: number): Promise<UtxoMass[] | null> {
	try {
		const res = await fetch(`/api/wallets/${walletId}/utxo-mass`);
		if (!res.ok) return null;
		const body = (await res.json()) as UtxoMassResponse;
		return Array.isArray(body?.masses) ? body.masses : null;
	} catch {
		return null;
	}
}

// ------------------------------------------------------------ dismissal key

/**
 * Stable fingerprint of a coin set ("txid:vout" keys, order-insensitive).
 * The consolidation suggestion keys its dismissal on this: dismissing hides
 * the card for exactly this set of high-mass coins, and a newly arrived
 * high-mass coin changes the hash so the suggestion reappears.
 */
export function utxoSetHash(keys: string[]): string {
	const s = [...keys].sort().join(',');
	let h = 5381;
	for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
	return h.toString(16);
}
