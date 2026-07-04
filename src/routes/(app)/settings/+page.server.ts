import { fail } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { hashPassword, verifyPassword, destroyUserSessions, createSession, SESSION_COOKIE } from '$lib/server/auth';
import {
	passwordChangeRetryAfter,
	notePasswordChangeFailure,
	notePasswordChangeSuccess,
	tooManyAttemptsMessage
} from '$lib/server/rateLimit';
import type { Actions, PageServerLoad } from './$types';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const load: PageServerLoad = async () => {
	return {};
};

export const actions: Actions = {
	profile: async ({ request, locals }) => {
		const form = await request.formData();
		const displayName = String(form.get('displayName') ?? '').trim();
		const email = String(form.get('email') ?? '').trim().toLowerCase();

		if (!displayName) return fail(400, { profileError: 'Display name is required.' });
		if (!EMAIL_RE.test(email)) return fail(400, { profileError: 'Enter a valid email address.' });

		const taken = db
			.prepare('SELECT id FROM users WHERE email = ? AND id != ?')
			.get(email, locals.user!.id);
		if (taken) return fail(400, { profileError: 'That email is already in use.' });

		db.prepare('UPDATE users SET display_name = ?, email = ? WHERE id = ?').run(
			displayName,
			email,
			locals.user!.id
		);
		return { profileSaved: true };
	},

	password: async ({ request, locals, cookies }) => {
		const form = await request.formData();
		const current = String(form.get('currentPassword') ?? '');
		const next = String(form.get('newPassword') ?? '');
		const confirm = String(form.get('confirmPassword') ?? '');

		if (next.length < 8)
			return fail(400, { passwordError: 'New password must be at least 8 characters.' });
		if (next !== confirm) return fail(400, { passwordError: 'New passwords do not match.' });

		const wait = passwordChangeRetryAfter(locals.user!.id);
		if (wait !== null) return fail(429, { passwordError: tooManyAttemptsMessage(wait) });

		const row = db
			.prepare('SELECT password_hash FROM users WHERE id = ?')
			.get(locals.user!.id) as { password_hash: string } | undefined;
		if (!row || !verifyPassword(current, row.password_hash)) {
			notePasswordChangeFailure(locals.user!.id);
			return fail(400, { passwordError: 'Current password is incorrect.' });
		}
		notePasswordChangeSuccess(locals.user!.id);

		db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(
			hashPassword(next),
			locals.user!.id
		);

		// Rotate all sessions: sign everything out, then start a fresh one here.
		destroyUserSessions(locals.user!.id);
		const { token, expiresAt } = createSession(locals.user!.id);
		cookies.set(SESSION_COOKIE, token, {
			path: '/',
			httpOnly: true,
			sameSite: 'lax',
			expires: expiresAt
		});

		return { passwordSaved: true };
	}
};
