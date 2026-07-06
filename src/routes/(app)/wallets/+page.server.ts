import { listWallets } from '$lib/server/wallets';
import { listMultisigSummaries } from '$lib/server/multisigScan';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	// Wallets and multisigs share this page; both scans run concurrently and each
	// tolerates per-item failures (errors maps, never a thrown load).
	const [{ wallets, errors }, { multisigs, errors: multisigErrors }] = await Promise.all([
		listWallets(locals.user!.id),
		listMultisigSummaries(locals.user!.id)
	]);
	return { wallets, errors, multisigs, multisigErrors };
};
