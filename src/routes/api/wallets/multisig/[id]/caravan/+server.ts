import { json, requireFeature } from '$lib/server/api';
import { getSignableMultisig } from '$lib/server/wallets/multisig';
import { caravanExport } from '$lib/server/multisigExport';
import { filenameSlug } from '$lib/server/walletExport';
import { MultisigError } from '$lib/server/bitcoin/multisig';
import { markBackedUp } from '$lib/server/backups';
import { childLogger } from '$lib/server/logger';
import type { RequestHandler } from './$types';

const log = childLogger('wallet');

/**
 * GET /api/wallets/multisig/:id/caravan — Caravan-compatible JSON wallet config.
 * Sparrow (and Caravan) import this file directly, making it the simplest
 * "see my multisig in another app" backup.
 */
export const GET: RequestHandler = async (event) => {
	// Gate Caravan config export behind the wallet_config_export feature flag.
	const user = requireFeature(event, 'wallet_config_export');
	const id = Number(event.params.id);
	// Registration/backup artifact with full key origins — owner or cosigner.
	const multisig = Number.isInteger(id) && id > 0 ? getSignableMultisig(user.id, id) : null;
	if (!multisig) return json({ error: 'Multisig not found' }, { status: 404 });

	try {
		const body = caravanExport(multisig);
		// Only the OWNER's download counts as backing up the wallet — wallet_backups
		// is wallet-level (no per-user scope), so a cosigner's export must not clear
		// the owner's "back up your wallet" reminder.
		if (multisig.userId === user.id) markBackedUp(user.id, 'multisig', id);
		const date = new Date().toISOString().slice(0, 10);
		return new Response(body, {
			headers: {
				'content-type': 'application/json; charset=utf-8',
				'content-disposition': `attachment; filename="cairn-${filenameSlug(multisig.name)}-backup-${date}.json"`
			}
		});
	} catch (e) {
		// MultisigError is a config-validation failure — a client error (400),
		// mapped identically across every export route (cairn-8jc7). Anything else
		// is a genuine server fault (500).
		if (e instanceof MultisigError) return json({ error: e.message }, { status: 400 });
		log.error({ err: e, multisigId: Number(event.params.id) }, 'wallet caravan export failed');
		return json({ error: 'Could not build the wallet config file.' }, { status: 500 });
	}
};
