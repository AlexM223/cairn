// POST /api/auth/recover/password  { password }
//
// Second completion path for ACCOUNT recovery (cairn-nhfe): finishes a verified
// recovery by SETTING A NEW PASSWORD instead of registering a new passkey. This
// exists because the passkey ceremony can be impossible on a plain-HTTP Umbrel
// deployment (WebAuthn requires a secure context) — without this, a verified
// recovery grant would dead-end with no way to actually get back in. Like the
// passkey path, this restores LOGIN only and never touches bitcoin.
//
// Order matters: the password is validated BEFORE the single-use recovery grant
// is consumed, so a weak password 400s WITHOUT burning the grant (the user can
// retry, or switch to the passkey path if one becomes available). Once the
// grant is consumed here it is gone — if a passkey-registration ceremony was
// racing on the same grant, whichever request reaches the server first wins;
// the loser sees the same "Recovery session expired" message consumeRecoveryGrant
// already produces for any other spent/unknown/expired token.
//
// A stolen recovery phrase/code can drive this path exactly as it could the
// passkey path, so it fires the same "was this you?" out-of-band alert
// (security_password_changed, unconditionally — unlike the Settings change-
// password flow, there is no "first password on a passkey-only account" case
// here where notifying would be noise: every recovery-password completion is
// exactly the event a stolen-secret attack would produce).

import { json, readJson } from '$lib/server/api';
import { getUserById, setUserPassword, createSession, setSessionCookie, MIN_PASSWORD_LENGTH } from '$lib/server/auth';
import { consumeRecoveryGrant, RECOVERY_GRANT_COOKIE } from '$lib/server/recovery';
import { sessionContextFrom } from '$lib/server/deviceTracking';
import { notify } from '$lib/server/notifications';
import { recordActivity } from '$lib/server/activity';
import { childLogger } from '$lib/server/logger';
import type { RequestHandler } from './$types';

const log = childLogger('recovery');

const GRANT_EXPIRED = 'Recovery session expired. Start again from the recovery page.';

export const POST: RequestHandler = async (event) => {
	const body = await readJson<{ password?: string }>(event);
	const password = String(body.password ?? '');

	// Validate BEFORE touching the grant — a weak password must not consume it.
	if (password.length < MIN_PASSWORD_LENGTH) {
		return json(
			{
				error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`,
				code: 'weak_password'
			},
			{ status: 400 }
		);
	}

	// Single-use, replay-safe consumption — identical semantics to the passkey
	// path's consumeRecoveryGrant call in recover/register/verify.
	const grant = consumeRecoveryGrant(event.cookies.get(RECOVERY_GRANT_COOKIE));
	if (!grant) {
		return json({ error: GRANT_EXPIRED }, { status: 400 });
	}

	const user = getUserById(grant.userId);
	if (!user) {
		return json({ error: GRANT_EXPIRED }, { status: 400 });
	}

	try {
		setUserPassword(user.id, password);
	} catch (e) {
		log.error({ err: e, userId: user.id }, 'recovery set password failed');
		return json({ error: 'Could not finish recovery.' }, { status: 500 });
	}

	// Grant is single-purpose and now spent; drop the cookie explicitly (mirrors
	// recover/register/verify).
	event.cookies.delete(RECOVERY_GRANT_COOKIE, { path: '/' });

	log.warn({ userId: user.id }, 'account recovered: new password set via recovery');
	recordActivity({
		type: 'account_recovery',
		level: 'warn',
		userId: user.id,
		message: 'Account recovery completed — a new password was set and login restored.'
	});
	// "Was this you?" parity with notifyNewPasskey(viaRecovery:true): a stolen
	// recovery phrase/code can drive this path exactly as it could the passkey
	// one, so the real owner must get the same out-of-band, warn-level alert no
	// matter which completion path an attacker (or the owner) used.
	notify({
		type: 'security_password_changed',
		userId: user.id,
		level: 'warn',
		title: 'Account recovered with a new password',
		body: 'Your account password was just set during account recovery. If this wasn’t you, secure your account immediately.',
		detail: { viaRecovery: true },
		link: '/settings'
	});

	// Establish the REAL session.
	const { token, expiresAt } = createSession(user.id, sessionContextFrom(event));
	setSessionCookie(event.cookies, token, expiresAt, event.url);
	return json({ user });
};
