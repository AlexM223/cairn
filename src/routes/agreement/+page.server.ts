import { redirect, fail } from '@sveltejs/kit';
import {
	DEFAULT_OPERATOR,
	getUserAgreement,
	hasAcceptedCurrentAgreement,
	recordUserAgreement
} from '$lib/server/disclosures';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, url }) => {
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
		alreadyAccepted: hasAcceptedCurrentAgreement(locals.user.id),
		// Onward destination after accepting (cairn-95yic). STRICT allowlist —
		// this is a post-auth redirect target, so it must never be an arbitrary
		// user-supplied path: the only recognized token is 'welcome-aboard'
		// (the invited-crew tour the signup redirect points at, which the
		// agreement gate would otherwise swallow — every fresh non-admin signup
		// passes through this gate before their first (app) page).
		next: url.searchParams.get('next') === 'welcome-aboard' ? ('welcome-aboard' as const) : null
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
		// Same strict allowlist as the load's `next`: the ONLY non-home target
		// is the welcome-aboard tour token, carried through the form as a
		// hidden field (the ?/accept action URL replaces the query string, so
		// a search param wouldn't survive the POST). Anything else goes home.
		redirect(303, form.get('next') === 'welcome-aboard' ? '/welcome-aboard' : '/');
	}
};
