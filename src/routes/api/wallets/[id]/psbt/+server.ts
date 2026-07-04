import { json } from '@sveltejs/kit';
import { requireUser, readJson } from '$lib/server/api';
import { buildDraft } from '$lib/server/transactions';
import { PsbtError } from '$lib/server/bitcoin/psbt';
import type { RequestHandler } from './$types';

/**
 * Construct an unsigned PSBT from this wallet and save it as a draft.
 * Body: { recipient, amount: sats | "max", feeRate: sat/vB }
 */
export const POST: RequestHandler = async (event) => {
	const user = requireUser(event);
	const walletId = Number(event.params.id);
	if (!Number.isInteger(walletId)) return json({ error: 'Bad wallet id' }, { status: 400 });

	const body = await readJson<{ recipient?: string; amount?: number | 'max'; feeRate?: number }>(
		event
	);

	try {
		const { draft, details } = await buildDraft(user.id, walletId, {
			recipient: String(body.recipient ?? ''),
			amount: body.amount === 'max' ? 'max' : Number(body.amount),
			feeRate: Number(body.feeRate)
		});
		return json({ draft, details }, { status: 201 });
	} catch (e) {
		if (e instanceof PsbtError) {
			const status = e.code === 'construction_failed' ? 404 : 400;
			return json({ error: e.message, code: e.code }, { status });
		}
		return json(
			{ error: e instanceof Error ? e.message : 'Could not build the transaction' },
			{ status: 502 }
		);
	}
};
