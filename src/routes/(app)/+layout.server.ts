import { redirect } from '@sveltejs/kit';
import {
	hasAcceptedAdminDisclosure,
	hasAcceptedCurrentAgreement
} from '$lib/server/disclosures';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = async ({ locals, url }) => {
	if (!locals.user) {
		const next = url.pathname === '/' ? '' : `?next=${encodeURIComponent(url.pathname)}`;
		redirect(302, `/login${next}`);
	}

	// Disclosure gates. The acceptance screens live at top-level /disclosure and
	// /agreement (outside this layout), so redirecting here can't loop.
	//  • The operator (admin) must accept the one-time infrastructure disclosure
	//    before doing anything on the instance — including inviting users.
	//  • Every other user must accept the current user agreement; a version bump
	//    (the admin edited the terms) re-gates them on their next visit.
	if (locals.user.isAdmin) {
		if (!hasAcceptedAdminDisclosure(locals.user.id)) redirect(302, '/disclosure');
	} else if (!hasAcceptedCurrentAgreement(locals.user.id)) {
		redirect(302, '/agreement');
	}

	return { user: locals.user };
};
