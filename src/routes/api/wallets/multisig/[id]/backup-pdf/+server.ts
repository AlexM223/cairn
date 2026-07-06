import { json, requireFeature } from '$lib/server/api';
import { getMultisig } from '$lib/server/wallets/multisig';
import { buildMultisigBackupPdf } from '$lib/server/multisigBackupPdf';
import { filenameSlug } from '$lib/server/walletExport';
import { markBackedUp } from '$lib/server/backups';
import { childLogger } from '$lib/server/logger';
import type { RequestHandler } from './$types';

const log = childLogger('wallet');

/**
 * GET /api/wallets/multisig/:id/backup-pdf — the printable "break glass in a
 * safe" physical backup: a single black-and-white PDF with the quorum, every
 * key, the receive descriptor, and a large QR of the exact Caravan config the
 * JSON download emits. Downloading it counts as a config backup (markBackedUp),
 * exactly like the JSON and descriptor exports.
 */
export const GET: RequestHandler = async (event) => {
	// Gate printable backup PDF export behind the wallet_config_export feature flag.
	const user = requireFeature(event, 'wallet_config_export');
	const id = Number(event.params.id);
	const multisig = Number.isInteger(id) && id > 0 ? getMultisig(user.id, id) : null;
	if (!multisig) return json({ error: 'Multisig not found' }, { status: 404 });

	try {
		const pdf = await buildMultisigBackupPdf(multisig);
		markBackedUp(user.id, 'multisig', id);
		const date = new Date().toISOString().slice(0, 10);
		// Copy into a plain-ArrayBuffer-backed view so it's a valid BlobPart
		// (the generator's Uint8Array is typed over ArrayBufferLike).
		return new Response(new Blob([new Uint8Array(pdf)], { type: 'application/pdf' }), {
			headers: {
				'content-type': 'application/pdf',
				'content-disposition': `attachment; filename="cairn-${filenameSlug(multisig.name)}-backup-${date}.pdf"`
			}
		});
	} catch (e) {
		log.error({ err: e, multisigId: id }, 'wallet backup PDF export failed');
		return json({ error: 'Could not build the printable backup.' }, { status: 500 });
	}
};
