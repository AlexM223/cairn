import { json, requireFeature } from '$lib/server/api';
import { getSignableMultisig, toMultisigConfig } from '$lib/server/wallets/multisig';
import { multisigToDescriptor, MultisigError } from '$lib/server/bitcoin/multisig';
import { descriptorBackup } from '$lib/server/multisigExport';
import { markBackedUp } from '$lib/server/backups';
import type { RequestHandler } from './$types';
import { childLogger } from '$lib/server/logger';

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
 * GET /api/wallets/multisig/:id/descriptor — both checksummed descriptors as JSON;
 * with ?download=1, a plain-text backup file instead (the artifact users
 * store to restore or cross-check the multisig in another tool).
 */
export const GET: RequestHandler = async (event) => {
	// Gate multisig descriptor export behind the wallet_config_export feature flag.
	const user = requireFeature(event, 'wallet_config_export');
	const id = Number(event.params.id);
	// The descriptor is a device-registration artifact carrying every key's full
	// path — owner or cosigner (both register the quorum to sign); not viewers.
	const multisig = Number.isInteger(id) && id > 0 ? getSignableMultisig(user.id, id) : null;
	if (!multisig) return json({ error: 'Multisig not found' }, { status: 404 });

	try {
		if (event.url.searchParams.get('download') === '1') {
			const body = descriptorBackup(multisig);
			// Owner-only backup credit (wallet_backups is wallet-level) — a cosigner's
			// descriptor download must not clear the owner's backup reminder.
			if (multisig.userId === user.id) markBackedUp(user.id, 'multisig', id);
			return new Response(body, {
				headers: {
					'content-type': 'text/plain; charset=utf-8',
					'content-disposition': `attachment; filename="cairn-multisig-${safeFilename(multisig.name)}-descriptor.txt"`
				}
			});
		}
		const config = toMultisigConfig(multisig);
		return json({
			receive: multisigToDescriptor(config, { chain: 0 }),
			change: multisigToDescriptor(config, { chain: 1 })
		});
	} catch (e) {
		if (!(e instanceof MultisigError)) {
			log.error({ err: e, multisigId: id }, 'wallet descriptor export failed');
		}
		const message =
			e instanceof MultisigError ? e.message : 'Could not export the multisig descriptor.';
		return json({ error: message }, { status: 500 });
	}
};
