import { json } from '@sveltejs/kit';
import { requireUser, readJson } from '$lib/server/api';
import { broadcastVaultTransaction } from '$lib/server/vaultTransactions';
import { BroadcastError } from '$lib/server/transactions';
import { childLogger } from '$lib/server/logger';
import { recordActivity } from '$lib/server/activity';
import type { RequestHandler } from './$types';

const log = childLogger('vault');

/**
 * Finalize and broadcast a quorum-complete vault transaction. Optionally
 * accepts one last signed PSBT in the body (merged through the same guarded
 * attach path first). Refuses below quorum with "X of M signatures collected"
 * and refuses transactions that already carry a txid; the underlying service
 * claims the broadcast atomically, so concurrent calls cannot double-send.
 */
export const POST: RequestHandler = async (event) => {
	const user = requireUser(event);
	const vaultId = Number(event.params.id);
	const txId = Number(event.params.txId);

	const body = await readJson<{ psbt?: string }>(event).catch(() => ({ psbt: undefined }));

	try {
		const { txid, transaction } = await broadcastVaultTransaction(
			user.id,
			vaultId,
			txId,
			typeof body.psbt === 'string' ? body.psbt : undefined
		);
		recordActivity({
			userId: user.id,
			type: 'broadcast',
			level: 'success',
			message: `Transaction broadcast successfully: ${txid.slice(0, 12)}…`,
			detail: { scope: 'vault', vaultId, txId, txid }
		});
		return json({ txid, transaction });
	} catch (e) {
		if (e instanceof BroadcastError) {
			const status = e.code === 'not_found' ? 404 : e.code === 'already_sent' ? 409 : 400;
			return json({ error: e.message, code: e.code }, { status });
		}
		// Unexpected: the broadcast reached neither a known error nor success.
		log.error({ err: e, vaultId, txId }, 'vault broadcast failed');
		return json({ error: e instanceof Error ? e.message : 'Broadcast failed' }, { status: 502 });
	}
};
