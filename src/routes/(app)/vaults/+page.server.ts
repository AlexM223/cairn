import { listVaultSummaries } from '$lib/server/vaultScan';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	const { vaults, errors } = await listVaultSummaries(locals.user!.id);
	return { vaults, errors };
};
