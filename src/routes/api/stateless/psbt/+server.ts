import { json, requireUser, readJson } from '$lib/server/api';
import { buildStatelessPsbt, statelessErrorInfo } from '$lib/server/stateless';
import type { RequestHandler } from './$types';
import { childLogger } from '$lib/server/logger';

const log = childLogger('stateless');

interface RecipientBody {
	address?: unknown;
	amount?: unknown;
}

interface CoinBody {
	txid?: unknown;
	vout?: unknown;
}

/**
 * POST /api/stateless/psbt { source, recipients, feeRate, onlyUtxos? }
 * Construct an unsigned multisig PSBT from the pasted config's live UTXOs.
 * Mirrors /api/vaults/[id]/psbt — including the `details.signingMass` block
 * and the quorum `progress` object (0 of M here) — but persists nothing: the
 * response PSBT is the client's to keep and walk through the signers.
 */
export const POST: RequestHandler = async (event) => {
	requireUser(event);
	const body = await readJson<{
		source?: unknown;
		recipients?: RecipientBody[];
		recipient?: unknown;
		amount?: unknown;
		feeRate?: unknown;
		onlyUtxos?: CoinBody[];
	}>(event);

	const toAmount = (a: unknown): number | 'max' => (a === 'max' ? 'max' : Number(a));

	const recipients: { address: string; amount: number | 'max' }[] =
		Array.isArray(body.recipients) && body.recipients.length > 0
			? body.recipients.map((r) => ({
					address: String(r?.address ?? ''),
					amount: toAmount(r?.amount)
				}))
			: [{ address: String(body.recipient ?? ''), amount: toAmount(body.amount) }];

	const onlyUtxos = Array.isArray(body.onlyUtxos)
		? body.onlyUtxos
				.map((c) => ({ txid: String(c?.txid ?? ''), vout: Number(c?.vout) }))
				.filter((c) => /^[0-9a-f]{64}$/i.test(c.txid) && Number.isInteger(c.vout) && c.vout >= 0)
		: undefined;

	try {
		const result = await buildStatelessPsbt(String(body.source ?? ''), {
			recipients,
			feeRate: Number(body.feeRate),
			onlyUtxos: onlyUtxos && onlyUtxos.length > 0 ? onlyUtxos : undefined
		});
		return json(result, { status: 201 });
	} catch (e) {
		const { status, message, code } = statelessErrorInfo(e);
		if (status >= 500) {
			log.error({ err: e, code, message }, 'stateless psbt build failed');
		}
		return json({ error: message, code }, { status });
	}
};
