import { json, requireUser } from '$lib/server/api';
import { getVault } from '$lib/server/vaults';
import { caravanExport } from '$lib/server/vaultExport';
import { VaultError } from '$lib/server/bitcoin/multisig';
import { childLogger } from '$lib/server/logger';
import type { RequestHandler } from './$types';

const log = childLogger('wallet');

function safeFilename(name: string): string {
	const slug = name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 40);
	return slug || 'vault';
}

/**
 * GET /api/vaults/:id/caravan — Caravan-compatible JSON wallet config.
 * Sparrow (and Caravan) import this file directly, making it the simplest
 * "see my vault in another app" backup.
 */
export const GET: RequestHandler = async (event) => {
	const user = requireUser(event);
	const id = Number(event.params.id);
	const vault = Number.isInteger(id) && id > 0 ? getVault(user.id, id) : null;
	if (!vault) return json({ error: 'Vault not found' }, { status: 404 });

	try {
		return new Response(caravanExport(vault), {
			headers: {
				'content-type': 'application/json; charset=utf-8',
				'content-disposition': `attachment; filename="cairn-vault-${safeFilename(vault.name)}.json"`
			}
		});
	} catch (e) {
		const message = e instanceof VaultError ? e.message : 'Could not build the wallet config file.';
		if (!(e instanceof VaultError)) {
			log.error({ err: e, vaultId: Number(event.params.id) }, 'wallet caravan export failed');
		}
		return json({ error: message }, { status: 500 });
	}
};
