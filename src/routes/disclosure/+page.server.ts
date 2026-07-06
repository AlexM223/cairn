import { redirect, fail } from '@sveltejs/kit';
import {
	ADMIN_DISCLOSURE,
	hasAcceptedAdminDisclosure,
	recordAdminDisclosure
} from '$lib/server/disclosures';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) redirect(302, '/login');
	// Only the operator sees this; a regular user has nothing to accept here.
	if (!locals.user.isAdmin) redirect(302, '/');
	if (hasAcceptedAdminDisclosure(locals.user.id)) redirect(302, '/');
	return { disclosure: ADMIN_DISCLOSURE };
};

export const actions: Actions = {
	default: async ({ locals, request }) => {
		if (!locals.user?.isAdmin) redirect(302, '/');
		const form = await request.formData();
		if (form.get('accept') !== 'on') {
			return fail(400, { error: 'Please check the box to accept before continuing.' });
		}
		recordAdminDisclosure(locals.user.id);
		redirect(303, '/');
	}
};
