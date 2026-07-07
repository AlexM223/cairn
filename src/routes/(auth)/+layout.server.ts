import { redirect } from '@sveltejs/kit';
import { httpsExternalPort } from '$lib/server/httpsPort';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = async ({ locals }) => {
	if (locals.user) redirect(302, '/');
	return {
		// The secure-address port, so login/signup pages can auto-hop returning
		// users to the HTTPS origin too (cairn-6uff) — the hop is most valuable
		// exactly here, before sign-in.
		httpsPort: httpsExternalPort()
	};
};
