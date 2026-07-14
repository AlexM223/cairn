// Settings → API tokens (cairn-ivae.1): create/revoke personal access tokens
// for scripting against your own instance. The token value is returned to the
// page exactly once, from the create action — only its hash is stored, so
// there is nothing retrievable to display afterwards.

import { fail } from '@sveltejs/kit';
import {
	createApiToken,
	listApiTokens,
	revokeApiToken,
	ApiTokenError
} from '$lib/server/apiTokens';
import { requireUser } from '$lib/server/api';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	return { tokens: listApiTokens(locals.user!.id) };
};

export const actions: Actions = {
	create: async (event) => {
		requireUser(event);
		const { request, locals } = event;
		const form = await request.formData();
		const name = String(form.get('name') ?? '');
		// '' = never expires; otherwise a day count from the select.
		const expiresRaw = String(form.get('expiresDays') ?? '').trim();
		let expiresDays: number | null = null;
		if (expiresRaw !== '') {
			expiresDays = Number(expiresRaw);
			if (!Number.isInteger(expiresDays) || expiresDays < 1 || expiresDays > 3650) {
				return fail(400, { error: 'Invalid expiry.' });
			}
		}
		try {
			const created = createApiToken(locals.user!.id, name, expiresDays);
			// The one and only surfacing of the raw token.
			return { created: { token: created.token, name: created.name } };
		} catch (e) {
			if (e instanceof ApiTokenError) return fail(400, { error: e.message });
			throw e;
		}
	},

	revoke: async (event) => {
		requireUser(event);
		const { request, locals } = event;
		const form = await request.formData();
		const id = Number(form.get('id'));
		if (!Number.isInteger(id)) return fail(400, { error: 'Bad token id.' });
		if (!revokeApiToken(locals.user!.id, id)) return fail(404, { error: 'Token not found.' });
		return { revoked: true };
	}
};
