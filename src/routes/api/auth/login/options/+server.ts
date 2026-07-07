// POST /api/auth/login/options { email }
// Returns WebAuthn request options (allowCredentials for this account) and
// stashes the challenge for /login/verify. Throttled to blunt credential
// stuffing and enumeration.

import { json, readJson } from '$lib/server/api';
import { getUserByEmail, credentialDescriptors } from '$lib/server/auth';
import { buildAuthenticationOptions, setAuthChallenge } from '$lib/server/webauthn';
import { clientIpFor, loginRetryAfter, noteLoginFailure, tooManyAttemptsMessage } from '$lib/server/rateLimit';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async (event) => {
	const body = await readJson<{ email?: string }>(event);
	const email = String(body.email ?? '');
	const ip = clientIpFor(event);

	const wait = loginRetryAfter(ip, email);
	if (wait !== null) return json({ error: tooManyAttemptsMessage(wait) }, { status: 429 });

	const user = getUserByEmail(email);
	const descriptors = user ? credentialDescriptors(user.id) : [];
	if (!user || descriptors.length === 0) {
		noteLoginFailure(ip, email);
		return json({ error: 'No passkey is registered for that email.', code: 'no_passkey' }, { status: 400 });
	}

	const options = await buildAuthenticationOptions(event, descriptors);
	setAuthChallenge(event, { challenge: options.challenge, userId: user.id });
	return json(options);
};
