import { error } from '@sveltejs/kit';
import { requireUser } from '$lib/server/api';
import { getTransaction } from '$lib/server/transactions';
import { base64 } from '@scure/base';
import type { RequestHandler } from './$types';

/**
 * Download the current PSBT as a binary .psbt file — the format Sparrow,
 * Electrum, ColdCard, and other signers expect. (Base64 is the transport
 * inside Cairn; the file on disk is the raw binary the standard defines.)
 */
export const GET: RequestHandler = async (event) => {
	const user = requireUser(event);
	const walletId = Number(event.params.id);
	const txId = Number(event.params.txId);

	const tx = getTransaction(user.id, walletId, txId);
	if (!tx) error(404, 'Transaction not found');

	let bytes: Uint8Array;
	try {
		bytes = base64.decode(tx.psbt.trim());
	} catch {
		error(500, 'Stored PSBT is corrupt');
	}

	const filename = `cairn-tx-${txId}${tx.txid ? '-' + tx.txid.slice(0, 8) : ''}.psbt`;
	return new Response(bytes as unknown as BodyInit, {
		headers: {
			'content-type': 'application/octet-stream',
			'content-disposition': `attachment; filename="${filename}"`
		}
	});
};
