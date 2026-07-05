import { json, requireUser } from '$lib/server/api';
import { getVault, toVaultConfig } from '$lib/server/vaults';
import { vaultToDescriptor, VaultError } from '$lib/server/bitcoin/multisig';
import { descriptorBackup } from '$lib/server/vaultExport';
import type { RequestHandler } from './$types';

function safeFilename(name: string): string {
	const slug = name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 40);
	return slug || 'vault';
}

/**
 * GET /api/vaults/:id/descriptor — both checksummed descriptors as JSON;
 * with ?download=1, a plain-text backup file instead (the artifact users
 * store to restore or cross-check the vault in another tool).
 */
export const GET: RequestHandler = async (event) => {
	const user = requireUser(event);
	const id = Number(event.params.id);
	const vault = Number.isInteger(id) && id > 0 ? getVault(user.id, id) : null;
	if (!vault) return json({ error: 'Vault not found' }, { status: 404 });

	try {
		if (event.url.searchParams.get('download') === '1') {
			return new Response(descriptorBackup(vault), {
				headers: {
					'content-type': 'text/plain; charset=utf-8',
					'content-disposition': `attachment; filename="cairn-vault-${safeFilename(vault.name)}-descriptor.txt"`
				}
			});
		}
		const config = toVaultConfig(vault);
		return json({
			receive: vaultToDescriptor(config, { chain: 0 }),
			change: vaultToDescriptor(config, { chain: 1 })
		});
	} catch (e) {
		const message =
			e instanceof VaultError ? e.message : 'Could not export the vault descriptor.';
		return json({ error: message }, { status: 500 });
	}
};
