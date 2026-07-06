import { error } from '@sveltejs/kit';
import { base64 } from '@scure/base';
import { requireUser } from '$lib/server/api';
import { getMultisigTransaction } from '$lib/server/multisigTransactions';
import type { RequestHandler } from './$types';

/**
 * Download the CURRENT combined PSBT as a binary .psbt file — what ColdCard,
 * Sparrow, Electrum, and other signers read. Because the stored PSBT already
 * carries every previously merged signature, each signer in the stepper works
 * from the accumulated state, and re-downloading mid-quorum is always safe.
 */
export const GET: RequestHandler = async (event) => {
	const user = requireUser(event);
	const multisigId = Number(event.params.id);
	const txId = Number(event.params.txId);

	const tx = getMultisigTransaction(user.id, multisigId, txId);
	if (!tx) error(404, 'Transaction not found');

	let bytes: Uint8Array;
	try {
		bytes = base64.decode(tx.psbt.trim());
	} catch {
		error(500, 'Stored PSBT is corrupt');
	}

	const filename = `cairn-multisig${multisigId}-tx${txId}.psbt`;
	return new Response(bytes as unknown as BodyInit, {
		headers: {
			'content-type': 'application/octet-stream',
			'content-disposition': `attachment; filename="${filename}"`,
			'cache-control': 'no-store'
		}
	});
};
