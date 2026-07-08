// POST /api/auth/register/verify { response, name? }
// Verifies the new passkey against the stashed challenge, then creates the user
// and stores the credential in one transaction, and signs them in.
//
// cairn-j1q9: no longer handles "reclaim" (attaching a passkey to an existing
// credential-less account) — that public, email-only path was a silent
// account-takeover vector. A restored account now gets back in only via
// /recover with a single-use code an admin mints for them.

import { json, readJson } from '$lib/server/api';
import { db } from '$lib/server/db';
import { registerUserWithHash, addCredential, createSession, setSessionCookie, AuthError } from '$lib/server/auth';
import { verifyRegistration, readRegChallenge, clearRegChallenge } from '$lib/server/webauthn';
import { sessionContextFrom } from '$lib/server/deviceTracking';
import { childLogger } from '$lib/server/logger';
import type { RegistrationResponseJSON } from '@simplewebauthn/server';
import type { RequestHandler } from './$types';

const log = childLogger('auth');

export const POST: RequestHandler = async (event) => {
	const body = await readJson<{ response?: RegistrationResponseJSON; name?: string }>(event);
	const pending = readRegChallenge(event);
	// Single-use: consume the challenge cookie now, whatever the outcome.
	clearRegChallenge(event);

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
	const newCredential = {
		credentialId: credential.id,
		publicKey: credential.publicKey,
		counter: credential.counter,
		transports: credential.transports,
		deviceType: credentialDeviceType,
		backedUp: credentialBackedUp,
		name: body.name ?? null
	};

	// Create the account and its first passkey atomically — never leave
	// a user with no way to sign in, nor a credential with no user.
	// A passkey signup never has a password, so this calls the
	// transaction-safe registerUserWithHash() core directly (passwordHash:
	// null) instead of the registerUser() wrapper — that core is guaranteed
	// to contain no `await`, which is required here: node:sqlite's
	// DatabaseSync only supports one transaction at a time, so any await
	// between BEGIN and COMMIT would let a concurrent request's own BEGIN
	// interleave and roll back THIS transaction (cairn-jlrb).
	db.exec('BEGIN');
	let user;
	try {
		user = registerUserWithHash(
			{
				email: pending.email,
				displayName: pending.displayName ?? '',
				inviteCode: pending.inviteCode
			},
			null
		);
		addCredential(user.id, newCredential);
		db.exec('COMMIT');
	} catch (e) {
		db.exec('ROLLBACK');
		clearRegChallenge(event);
		if (e instanceof AuthError) return json({ error: e.message, code: e.code }, { status: 400 });
		log.error({ err: e }, 'register verify failed');
		return json({ error: 'Could not create the account.' }, { status: 500 });
	}

	clearRegChallenge(event);
	const { token, expiresAt } = createSession(user.id, sessionContextFrom(event));
	setSessionCookie(event.cookies, token, expiresAt, event.url);
	// A brand-new account has exactly one passkey and no account-recovery set up.
	// Signal the UI to send them straight into the mandatory recovery-setup wizard
	// (getting back INTO Cairn if that one passkey is lost — NOT bitcoin recovery).
	// The client redirects here instead of the dashboard on a fresh signup.
	return json({ user, next: '/recovery-setup' }, { status: 201 });
};
