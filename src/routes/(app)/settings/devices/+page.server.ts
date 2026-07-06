// Settings → Your devices (cairn-5u2i.4): the read-back + revoke surface for
// the sessions and known_devices tables, which were previously write-only from
// the user's perspective. Everything is scoped to locals.user.id inside
// accountData.ts — a guessed foreign id is a no-op.

import { fail } from '@sveltejs/kit';
import { SESSION_COOKIE, currentSessionId } from '$lib/server/auth';
import {
	listUserSessions,
	revokeUserSession,
	listKnownDevices,
	forgetKnownDevice
} from '$lib/server/accountData';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, cookies }) => {
	const uid = locals.user!.id;
	const current = currentSessionId(cookies.get(SESSION_COOKIE));
	return {
		sessions: listUserSessions(uid, current),
		devices: listKnownDevices(uid)
	};
};

export const actions: Actions = {
	revokeSession: async ({ request, locals, cookies }) => {
		const form = await request.formData();
		const id = Number(form.get('id'));
		if (!Number.isInteger(id)) return fail(400, { error: 'Bad session id.' });
		// Revoking the session you're using is just "sign out" — point the user at
		// that instead of yanking the cookie out from under this response.
		if (id === currentSessionId(cookies.get(SESSION_COOKIE))) {
			return fail(400, { error: 'This is your current session — use Sign out instead.' });
		}
		if (!revokeUserSession(locals.user!.id, id)) {
			return fail(404, { error: 'Session not found.' });
		}
		return { revoked: true };
	},

	forgetDevice: async ({ request, locals }) => {
		const form = await request.formData();
		const fingerprint = String(form.get('fingerprint') ?? '');
		if (!fingerprint) return fail(400, { error: 'Bad device fingerprint.' });
		if (!forgetKnownDevice(locals.user!.id, fingerprint)) {
			return fail(404, { error: 'Device not found.' });
		}
		return { forgotten: true };
	}
};
