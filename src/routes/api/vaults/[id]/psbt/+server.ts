import { json } from '@sveltejs/kit';
import { requireUser, readJson } from '$lib/server/api';
import { buildVaultDraft, vaultTransactionProgress } from '$lib/server/vaultTransactions';
import { getVault } from '$lib/server/vaults';
import { PsbtError } from '$lib/server/bitcoin/psbt';
import { childLogger } from '$lib/server/logger';
import { recordActivity } from '$lib/server/activity';
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
 * Construct an unsigned multisig PSBT from this vault and save it as a draft.
 * Body: {
 *   recipients: { address, amount: sats | "max" }[],   // one or more outputs
 *   feeRate: sat/vB,
 *   onlyUtxos?: { txid, vout }[]                        // manual coin control
 * }
 * Mirrors /api/wallets/[id]/psbt; the response additionally carries the
 * quorum `progress` object (0 of M at this point) that the signing stepper
 * tracks through every subsequent attach.
 *
 * Response `details` carries the full ConstructedVaultPsbt, including the
 * optional `signingMass` block — per-signer device estimates plus
 * `totalSeconds` scaled by this vault's quorum M (every signer processes the
 * full parent mass; see signingMass.ts). Absent when the chosen inputs'
 * parents weren't all available.
 */
export const POST: RequestHandler = async (event) => {
	const user = requireUser(event);
	const vaultId = Number(event.params.id);
	if (!Number.isInteger(vaultId)) return json({ error: 'Bad vault id' }, { status: 400 });

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

	const onlyUtxos = Array.isArray(body.onlyUtxos)
		? body.onlyUtxos
				.map((c) => ({ txid: String(c?.txid ?? ''), vout: Number(c?.vout) }))
				.filter((c) => /^[0-9a-f]{64}$/i.test(c.txid) && Number.isInteger(c.vout) && c.vout >= 0)
		: undefined;

	try {
		const { draft, details } = await buildVaultDraft(user.id, vaultId, {
			recipients,
			feeRate: Number(body.feeRate),
			onlyUtxos: onlyUtxos && onlyUtxos.length > 0 ? onlyUtxos : undefined
		});
		const vault = getVault(user.id, vaultId)!;
		recordActivity({
			userId: user.id,
			type: 'signing_started',
			message: `Signing session started for wallet “${vault.name}”`,
			detail: { vaultId, threshold: vault.threshold, keys: vault.keys.length }
		});
		return json({ draft, details, progress: vaultTransactionProgress(vault, draft) }, { status: 201 });
	} catch (e) {
		if (e instanceof PsbtError) {
			const status = e.code === 'construction_failed' ? 404 : 400;
			return json({ error: e.message, code: e.code }, { status });
		}
		// Unexpected construction failure — not a known PsbtError.
		log.error({ err: e, vaultId }, 'wallet psbt build failed');
		return json(
			{ error: e instanceof Error ? e.message : 'Could not build the transaction' },
			{ status: 502 }
		);
	}
};
