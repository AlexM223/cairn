import { json } from '@sveltejs/kit';
import { requireFeature } from '$lib/server/api';
import { readSpendRequest, psbtBuildErrorResponse } from '$lib/server/walletApi';
import { buildDraft } from '$lib/server/transactions';
import type { RequestHandler } from './$types';

/**
 * Construct an unsigned PSBT from this wallet and save it as a draft.
 * Body: {
 *   recipients: { address, amount: sats | "max" }[],   // one or more outputs
 *   feeRate: sat/vB,
 *   onlyUtxos?: { txid, vout }[]                        // manual coin control
 * }
 * The pre-batch single-recipient shape { recipient, amount, feeRate } is still
 * accepted and treated as a length-1 recipients array.
 *
 * Response `details` carries the full ConstructedPsbt, including the optional
 * `signingMass` block (parent-transaction mass, tier, per-device signing-time
 * estimates, totalSeconds, warnLevel, splitSuggested — see signingMass.ts);
 * absent when the chosen inputs' parents weren't all available.
 *
 * `reservationWarning` (cairn QA R7 B4) is non-null only when `onlyUtxos` coin
 * control deliberately selected a coin another in-flight draft of this wallet
 * also references — automatic selection excludes those coins instead of
 * warning about them (see buildDraft in transactions.ts).
 */
export const POST: RequestHandler = async (event) => {
	// Building a spend is the core gated action. Coin control and batching are
	// finer gates applied inside readSpendRequest, only when the request
	// actually uses them.
	const user = requireFeature(event, 'send');
	const walletId = Number(event.params.id);
	if (!Number.isInteger(walletId)) return json({ error: 'Bad wallet id' }, { status: 400 });

	const spend = await readSpendRequest(event);

	try {
		const { draft, details, chainDepthWarning, reservationWarning } = await buildDraft(
			user.id,
			walletId,
			spend
		);
		return json({ draft, details, chainDepthWarning, reservationWarning }, { status: 201 });
	} catch (e) {
		return psbtBuildErrorResponse(e, { walletId });
	}
};
