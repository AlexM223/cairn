import { json, requireFeature } from '$lib/server/api';
import { getSignableMultisig } from '$lib/server/wallets/multisig';
import { coldcardRegistration } from '$lib/server/multisigExport';
import { filenameSlug } from '$lib/server/walletExport';
import { MultisigError } from '$lib/server/bitcoin/multisig';
import { markBackedUp } from '$lib/server/backups';
import type { RequestHandler } from './$types';
import { childLogger } from '$lib/server/logger';

const log = childLogger('wallet');

/**
 * GET /api/wallets/multisig/:id/coldcard — the ColdCard multisig registration file
 * (also accepted by Passport, Keystone, SeedSigner). Air-gapped devices must
 * import this before they will co-sign for the multisig.
 */
export const GET: RequestHandler = async (event) => {
	// Gate ColdCard registration export behind the wallet_config_export feature flag.
	const user = requireFeature(event, 'wallet_config_export');
	const id = Number(event.params.id);
	// Air-gapped registration file with full key origins — owner or cosigner.
	const multisig = Number.isInteger(id) && id > 0 ? getSignableMultisig(user.id, id) : null;
	if (!multisig) return json({ error: 'Multisig not found' }, { status: 404 });

	try {
		const body = coldcardRegistration(multisig);
		// Owner-only backup credit (wallet_backups is wallet-level) — a cosigner
		// registering their own device must not clear the owner's backup reminder.
		if (multisig.userId === user.id) markBackedUp(user.id, 'multisig', id);
		// Standard dated backup filename, comparable across a wallet's three export
		// buttons after a re-download or key rotation (cairn-vxum).
		const date = new Date().toISOString().slice(0, 10);
		return new Response(body, {
			headers: {
				'content-type': 'text/plain; charset=utf-8',
				'content-disposition': `attachment; filename="cairn-${filenameSlug(multisig.name)}-backup-${date}-coldcard.txt"`
			}
		});
	} catch (e) {
		// Config-validation failure → 400; anything else is a real server fault
		// (500). Same mapping in every export route (cairn-8jc7).
		if (e instanceof MultisigError) return json({ error: e.message }, { status: 400 });
		log.error({ err: e, multisigId: id }, 'wallet coldcard export failed');
		return json({ error: 'Could not build the ColdCard registration file.' }, { status: 500 });
	}
};
