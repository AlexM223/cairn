// POST /api/auth/login/verify { response }
// Verifies the passkey assertion against the stashed challenge, updates the
// replay counter, and opens a session.

import { json, readJson } from '$lib/server/api';
import {
	getCredentialForAuth,
	getUserById,
	updateCredentialCounter,
	createSession,
	setSessionCookie
} from '$lib/server/auth';
import { verifyAuthentication, readAuthChallenge, clearAuthChallenge } from '$lib/server/webauthn';
import { loginRetryAfter, noteLoginFailure, noteLoginSuccess, tooManyAttemptsMessage } from '$lib/server/rateLimit';
import { childLogger } from '$lib/server/logger';
import type { AuthenticationResponseJSON } from '@simplewebauthn/server';
import type { RequestHandler } from './$types';

const log = childLogger('auth');

export const POST: RequestHandler = async (event) => {
	const body = await readJson<{ response?: AuthenticationResponseJSON }>(event);
	const pending = readAuthChallenge(event);
	// Single-use: consume the challenge cookie now, whatever the outcome.
	clearAuthChallenge(event);
	const ip = event.getClientAddress();

	if (!pending || !body.response) {
		return json({ error: 'Sign-in session expired. Start again.' }, { status: 400 });
	}

	const record = getCredentialForAuth(body.response.id);
	// The credential must exist AND belong to the account that started this
	// ceremony — a challenge issued for one user cannot be spent by another's key.
	if (!record || record.userId !== pending.userId) {
		clearAuthChallenge(event);
		return json({ error: 'Unrecognized passkey.' }, { status: 400 });
	}
	if (record.disabled) {
		clearAuthChallenge(event);
		return json({ error: 'This account has been disabled.' }, { status: 403 });
	}

	const user = getUserById(record.userId);
	if (!user) {
		clearAuthChallenge(event);
		return json({ error: 'This account is unavailable.' }, { status: 403 });
	}

	const wait = loginRetryAfter(ip, user.email);
	if (wait !== null) return json({ error: tooManyAttemptsMessage(wait) }, { status: 429 });

	let verification;
	try {
		verification = await verifyAuthentication(event, body.response, pending.challenge, record.credential);
	} catch (e) {
		return json(
			{ error: e instanceof Error ? e.message : 'Passkey verification failed.' },
			{ status: 400 }
		);
	}
	if (!verification.verified) {
		noteLoginFailure(ip, user.email);
		return json({ error: 'Passkey verification failed.' }, { status: 400 });
	}

	updateCredentialCounter(record.credential.id, verification.authenticationInfo.newCounter);
	noteLoginSuccess(ip, user.email);
	clearAuthChallenge(event);

	try {
		const { token, expiresAt } = createSession(user.id);
		setSessionCookie(event.cookies, token, expiresAt, event.url);
	} catch (e) {
		log.error({ err: e, userId: user.id }, 'session creation failed after login');
		return json({ error: 'Could not start a session.' }, { status: 500 });
	}

	return json({ user });
};
