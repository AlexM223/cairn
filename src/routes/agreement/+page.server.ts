import { redirect, fail } from '@sveltejs/kit';
import {
	getUserAgreement,
	hasAcceptedCurrentAgreement,
	recordUserAgreement
} from '$lib/server/disclosures';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) redirect(302, '/login');
	return {
		agreement: getUserAgreement(),
		// When already accepted, the page is a read-only review (reachable from
		// Settings); otherwise it's the acceptance gate.
		alreadyAccepted: hasAcceptedCurrentAgreement(locals.user.id)
	};
};

export const actions: Actions = {
	default: async ({ locals, request, getClientAddress }) => {
		if (!locals.user) redirect(302, '/login');
		const form = await request.formData();
		if (form.get('accept') !== 'on') {
			return fail(400, { error: 'Please check the box to accept before continuing.' });
		}
		// Best-effort client IP for the operator's legal record.
		let ip: string | null = null;
		try {
			ip = getClientAddress();
		} catch {
			ip = null;
		}
		recordUserAgreement(locals.user.id, ip);
		redirect(303, '/');
	}
};
