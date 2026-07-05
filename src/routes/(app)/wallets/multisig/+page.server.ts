import { listMultisigSummaries } from '$lib/server/multisigScan';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	const { multisigs, errors } = await listMultisigSummaries(locals.user!.id);
	return { multisigs, errors };
};
