import { json } from '@sveltejs/kit';
import { requireFeature } from '$lib/server/api';
import { readSpendRequest, psbtBuildErrorResponse } from '$lib/server/walletApi';
import { buildMultisigDraft, multisigTransactionProgress } from '$lib/server/multisigTransactions';
import { getSignableMultisig } from '$lib/server/wallets/multisig';
import { recordActivity } from '$lib/server/activity';
import type { RequestHandler } from './$types';

/**
 * Construct an unsigned multisig PSBT from this multisig and save it as a draft.
 * Body: {
 *   recipients: { address, amount: sats | "max" }[],   // one or more outputs
 *   feeRate: sat/vB,
 *   onlyUtxos?: { txid, vout }[]                        // manual coin control
 * }
 * Mirrors /api/wallets/[id]/psbt; the response additionally carries the
 * quorum `progress` object (0 of M at this point) that the signing stepper
 * tracks through every subsequent attach.
 *
 * Response `details` carries the full ConstructedMultisigPsbt, including the
 * optional `signingMass` block — per-signer device estimates plus
 * `totalSeconds` scaled by this multisig's quorum M (every signer processes the
 * full parent mass; see signingMass.ts). Absent when the chosen inputs'
 * parents weren't all available.
 *
 * `reservationWarning` (cairn QA R7 B4) is non-null only when `onlyUtxos` coin
 * control deliberately selected a coin another in-flight draft of this
 * multisig also references (see buildMultisigDraft).
 */
export const POST: RequestHandler = async (event) => {
	// Building a spend is the core gated action; coin control and batching are
	// finer gates applied inside readSpendRequest, only when the request
	// actually uses them.
	const user = requireFeature(event, 'send');
	const multisigId = Number(event.params.id);
	if (!Number.isInteger(multisigId)) return json({ error: 'Bad multisig id' }, { status: 400 });

	const spend = await readSpendRequest(event);

	try {
		const { draft, details, chainDepthWarning, reservationWarning } = await buildMultisigDraft(
			user.id,
			multisigId,
			spend
		);
		// buildMultisigDraft already gated (owner or cosigner); re-read the same way.
		const multisig = getSignableMultisig(user.id, multisigId)!;
		recordActivity({
			userId: user.id,
			type: 'signing_started',
			message: `Signing session started for wallet “${multisig.name}”`,
			detail: { multisigId, threshold: multisig.threshold, keys: multisig.keys.length }
		});
		return json(
			{
				draft,
				details,
				progress: multisigTransactionProgress(multisig, draft),
				chainDepthWarning,
				reservationWarning
			},
			{ status: 201 }
		);
	} catch (e) {
		return psbtBuildErrorResponse(e, { multisigId });
	}
};
