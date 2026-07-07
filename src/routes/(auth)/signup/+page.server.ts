import { userCount } from '$lib/server/auth';
import { getInstanceSettings } from '$lib/server/settings';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ url }) => {
	const firstUser = userCount() === 0;
	const mode = getInstanceSettings().registrationMode;
	return {
		firstUser,
		registrationMode: mode,
		needsInvite: !firstUser && mode === 'invite',
		closed: !firstUser && mode === 'closed',
		// Prefill the invite field when arriving via an invite link
		// (/signup?invite=CAIRN-XXXX-XXXX).
		invite: url.searchParams.get('invite') ?? ''
	};
};

// Registration is a passkey ceremony driven client-side against
// /api/auth/register/{options,verify} — there is no form action here.
