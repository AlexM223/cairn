import { fail } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { listCredentials } from '$lib/server/auth';
import type { Actions, PageServerLoad } from './$types';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const load: PageServerLoad = async ({ locals }) => {
	// Passkeys are managed client-side against /api/auth/passkeys; the first
	// paint ships the current list.
	return { passkeys: listCredentials(locals.user!.id) };
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
	}
};
