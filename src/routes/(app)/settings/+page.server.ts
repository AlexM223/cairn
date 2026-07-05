import { fail } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import {
	listCredentials,
	hasPassword,
	verifyPassword,
	setUserPassword,
	destroyUserSessions,
	createSession,
	setSessionCookie,
	getAuthMode,
	MIN_PASSWORD_LENGTH
} from '$lib/server/auth';
import { hasRecoverySetup } from '$lib/server/recovery';
import type { Actions, PageServerLoad } from './$types';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const load: PageServerLoad = async ({ locals }) => {
	const uid = locals.user!.id;
	// Passkeys are managed client-side against /api/auth/passkeys; the first
	// paint ships the current list.
	// Account-recovery (login recovery) status — drives the "Recovery" section
	// and the persistent warning banner until it's set up.
	const recovery = hasRecoverySetup(uid);
	return {
		passkeys: listCredentials(uid),
		hasPassword: hasPassword(uid),
		authMode: getAuthMode(),
		recovery: {
			phrase: recovery.phrase,
			codesRemaining: recovery.codesRemaining,
			complete: recovery.phrase && recovery.codesRemaining > 0
		}
	};
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

	password: async ({ request, locals, cookies, url }) => {
		const form = await request.formData();
		const current = String(form.get('currentPassword') ?? '');
		const next = String(form.get('newPassword') ?? '');
		const confirm = String(form.get('confirmPassword') ?? '');
		const uid = locals.user!.id;

		if (next.length < MIN_PASSWORD_LENGTH)
			return fail(400, {
				passwordError: `New password must be at least ${MIN_PASSWORD_LENGTH} characters.`
			});
		if (next !== confirm) return fail(400, { passwordError: 'New passwords do not match.' });

		// Changing an existing password requires the current one; setting a first
		// password (passkey-only account) does not.
		if (hasPassword(uid)) {
			const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(uid) as
				| { password_hash: string | null }
				| undefined;
			if (!row?.password_hash || !verifyPassword(current, row.password_hash))
				return fail(400, { passwordError: 'Current password is incorrect.' });
		}

		setUserPassword(uid, next);

		// Rotate all sessions: sign everything out, then start a fresh one here.
		destroyUserSessions(uid);
		const { token, expiresAt } = createSession(uid);
		setSessionCookie(cookies, token, expiresAt, url);

		return { passwordSaved: true };
	}
};
