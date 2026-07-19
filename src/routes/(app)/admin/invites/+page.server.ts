import { fail } from '@sveltejs/kit';
import {
	createInvites,
	getInstanceName,
	listInvites,
	revokeInvite,
	setInstanceName,
	INSTANCE_NAME_MAX_LENGTH,
	WELCOME_MESSAGE_MAX_LENGTH
} from '$lib/server/admin';
import { assertTeamMode, requireAdmin } from '$lib/server/api';
import { AuthError } from '$lib/server/auth';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async () => {
	assertTeamMode();
	return {
		invites: listInvites(),
		// Come-aboard identity (cairn-s8g9a): the node name the invite landing
		// leads with, editable right where invites are made.
		instanceName: getInstanceName(),
		instanceNameMax: INSTANCE_NAME_MAX_LENGTH,
		welcomeMax: WELCOME_MESSAGE_MAX_LENGTH
	};
};

export const actions: Actions = {
	create: async (event) => {
		requireAdmin(event);
		assertTeamMode();
		const { request, locals } = event;
		const form = await request.formData();
		const count = Number(form.get('count') ?? 1);
		const maxUses = Number(form.get('maxUses') ?? 1);
		const expiresDays = Number(form.get('expiresDays') ?? 0) || null;
		const label = String(form.get('label') ?? '');

		// Validate ranges up front and tell the admin, rather than letting
		// createInvites() silently clamp out-of-range values (cairn-sh5h). The
		// bounds here mirror the number inputs' min/max and the clamps in
		// admin.ts, so a typed-in value like count=200 gets a clear error instead
		// of quietly producing 50 codes.
		if (!Number.isInteger(count) || count < 1 || count > 50)
			return fail(400, { error: 'How many must be a whole number between 1 and 50.' });
		if (!Number.isInteger(maxUses) || maxUses < 1 || maxUses > 1000)
			return fail(400, { error: 'Uses each must be a whole number between 1 and 1000.' });
		if (expiresDays !== null && (!Number.isInteger(expiresDays) || expiresDays < 0))
			return fail(400, { error: 'Expires in days must be 0 (never) or a positive whole number.' });

		try {
			const created = createInvites({
				createdBy: locals.user!.id,
				count,
				label,
				maxUses,
				expiresDays,
				welcomeMessage: String(form.get('welcomeMessage') ?? '')
			});
			return { created: created.map((i) => i.code) };
		} catch (e) {
			if (e instanceof AuthError) return fail(400, { error: e.message });
			throw e;
		}
	},

	// Come-aboard identity (cairn-s8g9a): save (or clear, with an empty value)
	// the node name shown on the invite landing / branded signup / welcome tour.
	saveName: async (event) => {
		requireAdmin(event);
		assertTeamMode();
		const form = await event.request.formData();
		try {
			setInstanceName(String(form.get('instanceName') ?? ''));
			return { nameSaved: true };
		} catch (e) {
			if (e instanceof AuthError) return fail(400, { error: e.message });
			throw e;
		}
	},

	revoke: async (event) => {
		requireAdmin(event);
		assertTeamMode();
		const form = await event.request.formData();
		const id = Number(form.get('id'));
		if (!Number.isInteger(id)) return fail(400, { error: 'Invalid invite id' });
		revokeInvite(id);
		return {};
	}
};
