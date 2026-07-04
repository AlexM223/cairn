import { fail } from '@sveltejs/kit';
import { createInvites, listInvites, revokeInvite } from '$lib/server/admin';
import { AuthError } from '$lib/server/auth';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async () => {
	return { invites: listInvites() };
};

export const actions: Actions = {
	create: async ({ request, locals }) => {
		const form = await request.formData();
		const count = Number(form.get('count') ?? 1);
		const maxUses = Number(form.get('maxUses') ?? 1);
		const expiresDays = Number(form.get('expiresDays') ?? 0) || null;
		const label = String(form.get('label') ?? '');

		try {
			const created = createInvites({
				createdBy: locals.user!.id,
				count,
				label,
				maxUses,
				expiresDays
			});
			return { created: created.map((i) => i.code) };
		} catch (e) {
			if (e instanceof AuthError) return fail(400, { error: e.message });
			throw e;
		}
	},

	revoke: async ({ request }) => {
		const form = await request.formData();
		const id = Number(form.get('id'));
		if (!Number.isInteger(id)) return fail(400, { error: 'Invalid invite id' });
		revokeInvite(id);
		return {};
	}
};
