import { json, requireUser } from '$lib/server/api';
import { getVault, deleteVault } from '$lib/server/vaults';
import { getVaultDetail, invalidateVaultCache, toVaultSummary } from '$lib/server/vaultScan';
import type { RequestHandler } from './$types';

function parseId(param: string): number | null {
	const id = Number(param);
	return Number.isInteger(id) && id > 0 ? id : null;
}

const notFound = () => json({ error: 'Vault not found' }, { status: 404 });

/** GET /api/vaults/:id — vault config plus full scan (balance, UTXOs, addresses, history). */
export const GET: RequestHandler = async (event) => {
	const user = requireUser(event);
	const id = parseId(event.params.id);
	if (id === null) return notFound();

	const vault = getVault(user.id, id);
	if (!vault) return notFound();

	try {
		const detail = await getVaultDetail(vault);
		return json({
			vault: toVaultSummary(vault),
			threshold: vault.threshold,
			keys: vault.keys,
			...detail
		});
	} catch (e) {
		return json({ error: e instanceof Error ? e.message : 'Vault scan failed' }, { status: 502 });
	}
};

/** DELETE /api/vaults/:id */
export const DELETE: RequestHandler = async (event) => {
	const user = requireUser(event);
	const id = parseId(event.params.id);
	if (id === null) return notFound();

	const vault = getVault(user.id, id);
	if (!vault || !deleteVault(user.id, id)) return notFound();
	invalidateVaultCache(vault);
	return json({ ok: true });
};
