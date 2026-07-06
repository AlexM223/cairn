import { json } from '@sveltejs/kit';
import { requireUser, requireFeature, readJson } from '$lib/server/api';
import { buildDraft } from '$lib/server/transactions';
import { PsbtError } from '$lib/server/bitcoin/psbt';
import { childLogger } from '$lib/server/logger';
import type { RequestHandler } from './$types';

const log = childLogger('wallet');

interface RecipientBody {
	address?: unknown;
	amount?: unknown;
}

interface CoinBody {
	txid?: unknown;
	vout?: unknown;
}

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
 */
export const POST: RequestHandler = async (event) => {
	// Building a spend is the core gated action. Coin control and batching are
	// finer gates checked below, only when the request actually uses them.
	const user = requireFeature(event, 'send');
	const walletId = Number(event.params.id);
	if (!Number.isInteger(walletId)) return json({ error: 'Bad wallet id' }, { status: 400 });

	const body = await readJson<{
		recipients?: RecipientBody[];
		recipient?: string;
		amount?: number | 'max';
		feeRate?: number;
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

	// Sanitize the coin allowlist down to well-formed (txid, vout) pairs; the
	// server-side selection treats anything unknown as simply not matching.
	const onlyUtxos = Array.isArray(body.onlyUtxos)
		? body.onlyUtxos
				.map((c) => ({ txid: String(c?.txid ?? ''), vout: Number(c?.vout) }))
				.filter((c) => /^[0-9a-f]{64}$/i.test(c.txid) && Number.isInteger(c.vout) && c.vout >= 0)
		: undefined;

	// Finer gates: only reject when the request actually exercises the feature, so
	// an ordinary single-recipient auto-coin-select spend is unaffected.
	if (onlyUtxos && onlyUtxos.length > 0) requireFeature(event, 'coin_control');
	if (recipients.length > 1) requireFeature(event, 'batch_transactions');

	try {
		const { draft, details, chainDepthWarning } = await buildDraft(user.id, walletId, {
			recipients,
			feeRate: Number(body.feeRate),
			onlyUtxos: onlyUtxos && onlyUtxos.length > 0 ? onlyUtxos : undefined
		});
		return json({ draft, details, chainDepthWarning }, { status: 201 });
	} catch (e) {
		if (e instanceof PsbtError) {
			const status = e.code === 'construction_failed' ? 404 : 400;
			return json({ error: e.message, code: e.code }, { status });
		}
		log.error({ err: e, walletId }, 'wallet psbt build failed');
		return json(
			{ error: e instanceof Error ? e.message : 'Could not build the transaction' },
			{ status: 502 }
		);
	}
};
