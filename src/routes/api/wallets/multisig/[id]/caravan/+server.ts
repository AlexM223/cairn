import { json, requireFeature } from '$lib/server/api';
import { getMultisig } from '$lib/server/wallets/multisig';
import { caravanExport } from '$lib/server/multisigExport';
import { MultisigError } from '$lib/server/bitcoin/multisig';
import { markBackedUp } from '$lib/server/backups';
import { childLogger } from '$lib/server/logger';
import type { RequestHandler } from './$types';

const log = childLogger('wallet');

function safeFilename(name: string): string {
	const slug = name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 40);
	return slug || 'multisig';
}

/**
 * GET /api/wallets/multisig/:id/caravan — Caravan-compatible JSON wallet config.
 * Sparrow (and Caravan) import this file directly, making it the simplest
 * "see my multisig in another app" backup.
 */
export const GET: RequestHandler = async (event) => {
	// Gate Caravan config export behind the wallet_config_export feature flag.
	const user = requireFeature(event, 'wallet_config_export');
	const id = Number(event.params.id);
	const multisig = Number.isInteger(id) && id > 0 ? getMultisig(user.id, id) : null;
	if (!multisig) return json({ error: 'Multisig not found' }, { status: 404 });

	try {
		const body = caravanExport(multisig);
		markBackedUp(user.id, 'multisig', id);
		const date = new Date().toISOString().slice(0, 10);
		return new Response(body, {
			headers: {
				'content-type': 'application/json; charset=utf-8',
				'content-disposition': `attachment; filename="cairn-${safeFilename(multisig.name)}-backup-${date}.json"`
			}
		});
	} catch (e) {
		const message = e instanceof MultisigError ? e.message : 'Could not build the wallet config file.';
		if (!(e instanceof MultisigError)) {
			log.error({ err: e, multisigId: Number(event.params.id) }, 'wallet caravan export failed');
		}
		return json({ error: message }, { status: 500 });
	}
};
