// Forced first-login credential reset (cairn-49xi.2). A bootstrap-created
// admin (bootstrapAdminFromEnv, auth.ts) logged in with a password that came
// from a deployment env var — on Umbrel that generated value sits on the
// install card and in logs indefinitely — and an email that's just a
// placeholder. This one-time step makes them choose their own password AND a
// real email together (2026-07-06 decision: both required in the same step,
// since a placeholder email means notifications silently go nowhere). The
// (app) layout gate redirects here until the flag clears; this route lives at
// top level, outside that layout, so the gate can't loop.
//
// Named action (not `default`) per the convention pinned by
// src/routes/agreement/server.test.ts (cairn-z6i1).

import { redirect, fail } from '@sveltejs/kit';
import {
	mustResetPassword,
	completeForcedCredentialReset,
	destroyUserSessions,
	createSession,
	setSessionCookie,
	AuthError,
	BOOTSTRAP_PLACEHOLDER_EMAIL,
	MIN_PASSWORD_LENGTH
} from '$lib/server/auth';
import { sessionContextFrom } from '$lib/server/deviceTracking';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) redirect(302, '/login');
	// Nothing to do here once the reset is done (or for any normal account).
	if (!mustResetPassword(locals.user.id)) redirect(302, '/');
	return {
		// Prefill only a REAL current email; the placeholder would just be a
		// value the user has to delete before typing their own.
		currentEmail: locals.user.email === BOOTSTRAP_PLACEHOLDER_EMAIL ? '' : locals.user.email,
		minPasswordLength: MIN_PASSWORD_LENGTH
	};
};

export const actions: Actions = {
	complete: async (event) => {
		const { locals, request, cookies, url } = event;
		if (!locals.user) redirect(302, '/login');
		if (!mustResetPassword(locals.user.id)) redirect(302, '/');

		const form = await request.formData();
		const email = String(form.get('email') ?? '');
		const password = String(form.get('password') ?? '');
		const confirm = String(form.get('confirm') ?? '');

		if (password !== confirm) {
			return fail(400, { error: 'Passwords do not match.', email });
		}

		try {
			completeForcedCredentialReset(locals.user.id, { email, password });
		} catch (e) {
			if (e instanceof AuthError) return fail(400, { error: e.message, email });
			throw e;
		}

		// Rotate every session and start a fresh one here — the generated install
		// password was visible to anyone who saw the platform's setup screen, so
		// any session it opened must die with it (mirrors the settings page's
		// password-change action).
		destroyUserSessions(locals.user.id);
		const { token, expiresAt } = createSession(locals.user.id, sessionContextFrom(event));
		setSessionCookie(cookies, token, expiresAt, url);

		redirect(303, '/');
	}
};
