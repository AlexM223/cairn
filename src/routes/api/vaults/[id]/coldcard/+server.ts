import { json, requireUser } from '$lib/server/api';
import { getVault } from '$lib/server/vaults';
import { coldcardRegistration } from '$lib/server/vaultExport';
import { VaultError } from '$lib/server/bitcoin/multisig';
import type { RequestHandler } from './$types';
import { childLogger } from '$lib/server/logger';

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
 * GET /api/vaults/:id/coldcard — the ColdCard multisig registration file
 * (also accepted by Passport, Keystone, SeedSigner). Air-gapped devices must
 * import this before they will co-sign for the vault.
 */
export const GET: RequestHandler = async (event) => {
	const user = requireUser(event);
	const id = Number(event.params.id);
	const vault = Number.isInteger(id) && id > 0 ? getVault(user.id, id) : null;
	if (!vault) return json({ error: 'Vault not found' }, { status: 404 });

	try {
		return new Response(coldcardRegistration(vault), {
			headers: {
				'content-type': 'text/plain; charset=utf-8',
				'content-disposition': `attachment; filename="cairn-vault-${safeFilename(vault.name)}-coldcard.txt"`
			}
		});
	} catch (e) {
		if (!(e instanceof VaultError)) {
			log.error({ err: e, vaultId: id }, 'wallet coldcard export failed');
		}
		const message =
			e instanceof VaultError ? e.message : 'Could not build the ColdCard registration file.';
		return json({ error: message }, { status: 500 });
	}
};
