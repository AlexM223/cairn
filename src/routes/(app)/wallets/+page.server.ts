import { listWallets } from '$lib/server/wallets';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	const { wallets, errors } = await listWallets(locals.user!.id);
	return { wallets, errors };
};
