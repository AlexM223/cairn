import { json, requireUser } from '$lib/server/api';
import { getMultisig, toMultisigConfig } from '$lib/server/wallets/multisig';
import { multisigToDescriptor, MultisigError } from '$lib/server/bitcoin/multisig';
import { descriptorBackup } from '$lib/server/multisigExport';
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
	const user = requireUser(event);
	const id = Number(event.params.id);
	const multisig = Number.isInteger(id) && id > 0 ? getMultisig(user.id, id) : null;
	if (!multisig) return json({ error: 'Multisig not found' }, { status: 404 });

	try {
		if (event.url.searchParams.get('download') === '1') {
			return new Response(descriptorBackup(multisig), {
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
