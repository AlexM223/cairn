import { json, requireUser } from '$lib/server/api';
import {
	getUserMassProfile,
	quorumSecondsRange,
	sampleLikelySpend,
	TYPICAL_SPEND_PROFILE
} from '$lib/server/bitcoin/signingMass';
import type { RequestHandler } from './$types';

/** Standard quorum presets the multisig-creation wizard always compares against. */
const PRESETS: [number, number][] = [
	[2, 3],
	[3, 5]
];

const MAX_KEYS = 15; // consensus CHECKMULTISIG limit

/**
 * GET /api/signing-time-preview?m=2&n=3 — quorum-comparison signing-time
 * estimates for the multisig-creation wizard: the requested (m, n) plus the
 * standard presets (2-of-3, 3-of-5), deduplicated.
 *
 * Basis (documented tradeoff — this preview must be INSTANT, so it never
 * fetches parents or scans wallets synchronously):
 *   'your-utxos'  when cached mass data exists for the user's wallets
 *                 (populated by the utxo-mass endpoint), sampled down to the
 *                 top UTXOs by value as the likely spend set — see
 *                 sampleLikelySpend;
 *   'typical'     otherwise: a documented handful of P2P-parent inputs.
 *
 * Response: { basis, estimates: { m, n, totalSecondsLo, totalSecondsHi }[] }
 * Totals are whole-ceremony (per-signer × m), bracketed across device kinds
 * (fastest device's low bound, slowest device's high bound).
 */
export const GET: RequestHandler = (event) => {
	const user = requireUser(event);

	const m = Number(event.url.searchParams.get('m'));
	const n = Number(event.url.searchParams.get('n'));
	if (
		!Number.isInteger(m) ||
		!Number.isInteger(n) ||
		m < 1 ||
		n < m ||
		n > MAX_KEYS
	) {
		return json(
			{ error: `Quorum must satisfy 1 <= m <= n <= ${MAX_KEYS}.` },
			{ status: 400 }
		);
	}

	const profile = getUserMassProfile(user.id);
	const basis = profile.length > 0 ? ('your-utxos' as const) : ('typical' as const);
	const spend = profile.length > 0 ? sampleLikelySpend(profile) : TYPICAL_SPEND_PROFILE;

	const combos: [number, number][] = [];
	for (const combo of [...PRESETS, [m, n] as [number, number]]) {
		if (!combos.some(([cm, cn]) => cm === combo[0] && cn === combo[1])) combos.push(combo);
	}

	const estimates = combos.map(([qm, qn]) => {
		const range = quorumSecondsRange({
			totalParentVsize: spend.totalParentVsize,
			inputCount: spend.inputCount,
			threshold: qm,
			totalKeys: qn
		});
		return { m: qm, n: qn, totalSecondsLo: range.lo, totalSecondsHi: range.hi };
	});

	return json({ basis, estimates });
};
