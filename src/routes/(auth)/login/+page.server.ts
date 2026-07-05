import { redirect } from '@sveltejs/kit';
import { userCount } from '$lib/server/auth';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async () => {
	// Brand-new instance: send straight to first-admin signup.
	if (userCount() === 0) redirect(302, '/signup');
	return {};
};

// Sign-in is a passkey ceremony driven client-side against
// /api/auth/login/{options,verify} — there is no form action here.
