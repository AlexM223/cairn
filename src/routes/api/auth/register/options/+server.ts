// POST /api/auth/register/options { email, displayName, inviteCode? }
// Validates registration eligibility and returns WebAuthn creation options for
// the browser to make a new passkey. The challenge is stashed in a cookie for
// the matching /register/verify call. No user is created here.
//
// cairn-j1q9: this used to also serve a public "reclaim" path — any anonymous
// caller who knew a credential-less account's email could register a fresh
// passkey against it (silent account takeover). That branch is gone. An
// account restored from a backup (which arrives with no password/passkeys) is
// no longer reachable through signup at all — its owner gets back in via
// /recover, seeded by a single-use code an admin mints for them
// (mintAdminRecoveryCode / POST /api/admin/users).

import { json, readJson } from '$lib/server/api';
import { assertCanRegister, AuthError } from '$lib/server/auth';
import { buildRegistrationOptions, setRegChallenge } from '$lib/server/webauthn';
import { clientIpFor, inviteRetryAfter, noteInviteFailure, tooManyAttemptsMessage } from '$lib/server/rateLimit';
import { childLogger } from '$lib/server/logger';
import type { RequestHandler } from './$types';

const log = childLogger('auth');

export const POST: RequestHandler = async (event) => {
	const body = await readJson<{ email?: string; displayName?: string; inviteCode?: string }>(event);
	const email = String(body.email ?? '');
	const displayName = String(body.displayName ?? '');
	const inviteCode = String(body.inviteCode ?? '') || undefined;
	const ip = clientIpFor(event);

	// Throttle invite-code guessing before touching anything.
	const wait = inviteRetryAfter(ip);
	if (wait !== null) return json({ error: tooManyAttemptsMessage(wait) }, { status: 429 });

	try {
		assertCanRegister({ email, displayName, inviteCode });
	} catch (e) {
		if (e instanceof AuthError) {
			if (e.code === 'bad_invite') noteInviteFailure(ip);
			return json({ error: e.message, code: e.code }, { status: 400 });
		}
		log.error({ err: e }, 'register options failed');
		return json({ error: 'Could not start registration.' }, { status: 500 });
	}

	const options = await buildRegistrationOptions(event, { email, displayName, exclude: [] });
	setRegChallenge(event, { challenge: options.challenge, email, displayName, inviteCode });
	return json(options);
};
