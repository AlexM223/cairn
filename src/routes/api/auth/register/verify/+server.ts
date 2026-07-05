// POST /api/auth/register/verify { response, name? }
// Verifies the new passkey against the stashed challenge, then creates the user
// and stores the credential in one transaction, and signs them in.

import { json, readJson } from '$lib/server/api';
import { db } from '$lib/server/db';
import {
	registerUser,
	addCredential,
	createSession,
	setSessionCookie,
	AuthError
} from '$lib/server/auth';
import { verifyRegistration, readRegChallenge, clearRegChallenge } from '$lib/server/webauthn';
import { childLogger } from '$lib/server/logger';
import type { RegistrationResponseJSON } from '@simplewebauthn/server';
import type { RequestHandler } from './$types';

const log = childLogger('auth');

export const POST: RequestHandler = async (event) => {
	const body = await readJson<{ response?: RegistrationResponseJSON; name?: string }>(event);
	const pending = readRegChallenge(event);

	// Must be a signup ceremony (has email, no userId). An add-passkey cookie
	// (userId set) belongs to /api/auth/passkeys, not here.
	if (!pending || !pending.email || pending.userId != null || !body.response) {
		return json({ error: 'Registration session expired. Start again.' }, { status: 400 });
	}

	let verification;
	try {
		verification = await verifyRegistration(event, body.response, pending.challenge);
	} catch (e) {
		return json(
			{ error: e instanceof Error ? e.message : 'Passkey verification failed.' },
			{ status: 400 }
		);
	}
	if (!verification.verified || !verification.registrationInfo) {
		return json({ error: 'Passkey could not be verified.' }, { status: 400 });
	}

	const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo;

	// Create the account and its first passkey atomically — never leave a user
	// with no way to sign in, nor a credential with no user.
	db.exec('BEGIN');
	let user;
	try {
		user = registerUser({
			email: pending.email,
			displayName: pending.displayName ?? '',
			inviteCode: pending.inviteCode
		});
		addCredential(user.id, {
			credentialId: credential.id,
			publicKey: credential.publicKey,
			counter: credential.counter,
			transports: credential.transports,
			deviceType: credentialDeviceType,
			backedUp: credentialBackedUp,
			name: body.name ?? null
		});
		db.exec('COMMIT');
	} catch (e) {
		db.exec('ROLLBACK');
		clearRegChallenge(event);
		if (e instanceof AuthError) return json({ error: e.message, code: e.code }, { status: 400 });
		log.error({ err: e }, 'register verify failed');
		return json({ error: 'Could not create the account.' }, { status: 500 });
	}

	clearRegChallenge(event);
	const { token, expiresAt } = createSession(user.id);
	setSessionCookie(event.cookies, token, expiresAt);
	return json({ user }, { status: 201 });
};
