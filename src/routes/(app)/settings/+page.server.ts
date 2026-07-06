import { fail, redirect } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { deleteOwnAccount } from '$lib/server/accountDeletion';
import { AuthError } from '$lib/server/auth';
import { invalidateWalletCache } from '$lib/server/bitcoin/walletScan';
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
import { notify } from '$lib/server/notifications';
import { sessionContextFrom } from '$lib/server/deviceTracking';
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

	password: async (event) => {
		const { request, locals, cookies, url } = event;
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

		const wasExisting = hasPassword(uid);
		setUserPassword(uid, next);

		// Security alert (cairn-5gpv.5): password is Cairn's default auth method, so a
		// silent change is a bigger blind spot than the new-passkey case webauthn.ts
		// already covers. Fire "was this you?" so an attacker who changes the password
		// to lock out the real owner leaves a signal on every enabled channel. Only for
		// an actual CHANGE — setting a first password on a passkey-only account is
		// expected and self-initiated. Best-effort: notify() never throws.
		if (wasExisting) {
			notify({
				type: 'security_password_changed',
				userId: uid,
				level: 'warn',
				title: 'Password changed',
				body: 'Your account password was just changed. If this wasn’t you, secure your account immediately — someone with access could lock you out.',
				link: '/settings'
			});
		}

		// Rotate all sessions: sign everything out, then start a fresh one here.
		// Pass the request context so the new session is recorded as this (already
		// known) device — no spurious new-device alert on top of the password one.
		destroyUserSessions(uid);
		const { token, expiresAt } = createSession(uid, sessionContextFrom(event));
		setSessionCookie(cookies, token, expiresAt, url);

		return { passwordSaved: true };
	},

	/**
	 * Danger zone (cairn-5u2i.2): delete the caller's OWN account after a typed
	 * confirmation, mirroring the admin reset-instance pattern. Everything the
	 * user owns goes; multisigs they merely participated in survive for their
	 * owner (only the share row is removed).
	 */
	deleteAccount: async ({ request, locals }) => {
		const form = await request.formData();
		if (String(form.get('confirm') ?? '') !== 'DELETE')
			return fail(400, { deleteError: 'Type DELETE to confirm deleting your account.' });

		try {
			deleteOwnAccount(locals.user!.id);
		} catch (e) {
			if (e instanceof AuthError && e.code === 'last_admin') {
				return fail(400, { deleteError: e.message });
			}
			throw e;
		}
		invalidateWalletCache(); // drop cached scans for the deleted wallets

		// The account (and every session) is gone; the stale cookie fails auth.
		redirect(303, '/login');
	}
};
