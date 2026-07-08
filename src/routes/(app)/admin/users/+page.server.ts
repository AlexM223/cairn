import { fail } from '@sveltejs/kit';
import { listUsers, setUserAdmin, setUserDisabled } from '$lib/server/admin';
import { overrideCountsByUser } from '$lib/server/featureFlags/admin';
import { assertTeamMode, requireAdmin } from '$lib/server/api';
import { AuthError } from '$lib/server/auth';
import { db } from '$lib/server/db';
import { notify } from '$lib/server/notifications';
import type { RequestEvent } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async () => {
	assertTeamMode();
	// Attach each user's feature-override count so the list can badge users whose
	// features differ from the instance default (links to their detail page).
	const counts = overrideCountsByUser();
	const users = listUsers().map((u) => ({ ...u, overrideCount: counts.get(u.id) ?? 0 }));
	return { users };
};

function userAction(fn: (id: number) => void) {
	return async (event: RequestEvent) => {
		requireAdmin(event);
		assertTeamMode();
		const form = await event.request.formData();
		const id = Number(form.get('id'));
		if (!Number.isInteger(id)) return fail(400, { error: 'Invalid user id' });
		try {
			fn(id);
		} catch (e) {
			if (e instanceof AuthError) return fail(400, { error: e.message });
			throw e;
		}
		return { ok: true };
	};
}

/** Human label for a user, for the admin-broadcast notification body. */
function userLabel(id: number): string {
	const row = db.prepare('SELECT email, display_name FROM users WHERE id = ?').get(id) as
		| { email: string; display_name: string | null }
		| undefined;
	return row?.display_name?.trim() || row?.email || `user #${id}`;
}

/**
 * Disable / re-enable a user AND broadcast it to every admin (cairn-5gpv.8).
 * Disabling a user is a moderation/security action other admins on a multi-admin
 * instance should learn about without having to watch /admin/logs. userId:null
 * fans the notification out to all admins per their channel prefs.
 */
function setDisabledAction(disabled: boolean) {
	return async (event: RequestEvent) => {
		requireAdmin(event);
		assertTeamMode();
		const { request, locals } = event;
		const form = await request.formData();
		const id = Number(form.get('id'));
		if (!Number.isInteger(id)) return fail(400, { error: 'Invalid user id' });
		try {
			setUserDisabled(id, disabled);
		} catch (e) {
			if (e instanceof AuthError) return fail(400, { error: e.message });
			throw e;
		}
		const actor = locals.user?.displayName || locals.user?.email || 'An admin';
		const target = userLabel(id);
		notify({
			type: 'admin_user_disabled',
			userId: null,
			level: 'warn',
			title: disabled ? 'User account disabled' : 'User account re-enabled',
			body: `${actor} ${disabled ? 'disabled' : 're-enabled'} the account for ${target}.`,
			detail: { targetUserId: id, disabled, actorUserId: locals.user?.id ?? null },
			link: `/admin/users/${id}`
		});
		return { ok: true };
	};
}

export const actions: Actions = {
	disable: setDisabledAction(true),
	enable: setDisabledAction(false),
	promote: userAction((id) => setUserAdmin(id, true)),
	demote: userAction((id) => setUserAdmin(id, false))
};
