import { getUserAgreement } from '$lib/server/disclosures';
import type { PageServerLoad } from './$types';

// Public — no auth. The operator agreement is meant to be readable by anyone
// deciding whether to use this instance.
export const load: PageServerLoad = async ({ locals }) => {
	return {
		agreement: getUserAgreement(),
		signedIn: !!locals.user
	};
};
