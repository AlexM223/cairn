// POST /api/auth/recover/register/options  {}
//
// Second step of ACCOUNT recovery (getting back INTO Cairn after losing every
// passkey) — this has NOTHING to do with bitcoin. Authorization comes SOLELY
// from the short-lived recovery-grant cookie minted by /recover/verify; no
// existing session is required.
//
// Peeks (does NOT consume) the grant to find the user, then returns WebAuthn
// creation options for a brand-new passkey, EXCLUDING the account's existing
// (lost) passkeys so the same authenticator isn't double-registered. The
// challenge is stashed for the matching /recover/register/verify call, which
// consumes the grant and establishes the real session.

import { json } from '$lib/server/api';
import { getUserById, credentialDescriptors } from '$lib/server/auth';
import {
	peekRecoveryGrant,
	RECOVERY_GRANT_COOKIE
} from '$lib/server/recovery';
import { buildRegistrationOptions, setRegChallenge } from '$lib/server/webauthn';
import { childLogger } from '$lib/server/logger';
import type { RequestHandler } from './$types';

const log = childLogger('recovery');

export const POST: RequestHandler = async (event) => {
	// Authorization is the grant cookie alone. Peek (don't consume) so the
	// single-use consume happens in the verify step, right before addCredential.
	const grant = peekRecoveryGrant(event.cookies.get(RECOVERY_GRANT_COOKIE));
	if (!grant) {
		return json(
			{ error: 'Recovery session expired. Start again from the recovery page.' },
			{ status: 400 }
		);
	}

	const user = getUserById(grant.userId);
	if (!user) {
		return json(
			{ error: 'Recovery session expired. Start again from the recovery page.' },
			{ status: 400 }
		);
	}

	const options = await buildRegistrationOptions(event, {
		email: user.email,
		displayName: user.displayName,
		// Exclude the account's existing (lost) passkeys — this is the reclaim-like
		// path the hasNoCredentials gate can't serve, so an account WITH lost
		// credentials can still add a fresh one.
		exclude: credentialDescriptors(user.id)
	});

	// Stash the challenge bound to this user id for the verify step.
	setRegChallenge(event, { challenge: options.challenge, userId: user.id });
	log.info({ userId: user.id }, 'recovery passkey registration started');
	return json(options);
};
