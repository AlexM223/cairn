import { listWallets } from '$lib/server/wallets';
import { listVaultSummaries } from '$lib/server/vaultScan';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	// Wallets and vaults share this page; both scans run concurrently and each
	// tolerates per-item failures (errors maps, never a thrown load).
	const [{ wallets, errors }, { vaults, errors: vaultErrors }] = await Promise.all([
		listWallets(locals.user!.id),
		listVaultSummaries(locals.user!.id)
	]);
	return { wallets, errors, vaults, vaultErrors };
};
