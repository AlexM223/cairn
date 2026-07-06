import { redirect, fail } from '@sveltejs/kit';
import {
	DEFAULT_OPERATOR,
	getUserAgreement,
	hasAcceptedCurrentAgreement,
	recordUserAgreement
} from '$lib/server/disclosures';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) redirect(302, '/login');
	const agreement = getUserAgreement();
	return {
		agreement,
		// Whether the admin has set a real operator name — the template avoids the
		// awkward "operated by the operator of this Cairn instance" placeholder when
		// they haven't (cairn-lngx, cairn-qf1e).
		hasCustomOperator: agreement.operator.trim() !== '' && agreement.operator !== DEFAULT_OPERATOR,
		// When already accepted, the page is a read-only review (reachable from
		// Settings); otherwise it's the acceptance gate.
		alreadyAccepted: hasAcceptedCurrentAgreement(locals.user.id)
	};
};

export const actions: Actions = {
	// Named action (not `default`) so the form always POSTs to an explicit
	// `?/accept` target. A bare default action can collide with SvelteKit's
	// reserved `?/default` name and 500 the mandatory onboarding gate.
	accept: async ({ locals, request, getClientAddress }) => {
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
