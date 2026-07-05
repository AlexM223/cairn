// POST /api/auth/recover/register/verify  { response, name? }
//
// Final step of ACCOUNT recovery (getting back INTO Cairn). Consumes the
// single-use recovery grant, verifies the new passkey against the stashed
// challenge, attaches it to the granted user, and establishes a REAL session.
// Authorization is the grant cookie alone (no existing session). This restores
// LOGIN only — it never touches bitcoin.

import { json, readJson } from '$lib/server/api';
import {
	getUserById,
	addCredential,
	createSession,
	setSessionCookie
} from '$lib/server/auth';
import {
	consumeRecoveryGrant,
	RECOVERY_GRANT_COOKIE
} from '$lib/server/recovery';
import {
	verifyRegistration,
	readRegChallenge,
	clearRegChallenge,
	notifyNewPasskey
} from '$lib/server/webauthn';
import { recordActivity } from '$lib/server/activity';
import { childLogger } from '$lib/server/logger';
import type { RegistrationResponseJSON } from '@simplewebauthn/server';
import type { RequestHandler } from './$types';

const log = childLogger('recovery');

export const POST: RequestHandler = async (event) => {
	const body = await readJson<{ response?: RegistrationResponseJSON; name?: string }>(event);
	const pending = readRegChallenge(event);
	// Single-use: consume the challenge cookie now, whatever the outcome.
	clearRegChallenge(event);

	// Consume the grant up front (single-use, guards against replay). Do this
	// before verification so a replayed grant can't drive a second registration.
	const grant = consumeRecoveryGrant(event.cookies.get(RECOVERY_GRANT_COOKIE));
	if (!grant) {
		return json(
			{ error: 'Recovery session expired. Start again from the recovery page.' },
			{ status: 400 }
		);
	}

	// Must be a recovery-registration ceremony: the stashed challenge is bound to
	// exactly the user the grant authorizes.
	if (!pending || pending.userId == null || pending.userId !== grant.userId || !body.response) {
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
	try {
		addCredential(user.id, {
			credentialId: credential.id,
			publicKey: credential.publicKey,
			counter: credential.counter,
			transports: credential.transports,
			deviceType: credentialDeviceType,
			backedUp: credentialBackedUp,
			name: body.name ?? null
		});
	} catch (e) {
		log.error({ err: e, userId: user.id }, 'recovery add credential failed');
		return json({ error: 'Could not finish recovery.' }, { status: 500 });
	}

	// Grant is single-purpose and now spent; drop the cookie explicitly.
	event.cookies.delete(RECOVERY_GRANT_COOKIE, { path: '/' });

	log.warn({ userId: user.id }, 'account recovered: new passkey registered via recovery');
	recordActivity({
		type: 'account_recovery',
		level: 'warn',
		userId: user.id,
		message: 'Account recovery completed — a new passkey was registered and login restored.'
	});
	// security_new_passkey (Unit 8): the higher-signal recovery variant — this is
	// exactly the event a stolen-recovery-phrase attack would trigger, so it must
	// reach the real owner via out-of-band channels (email/Telegram), not just the
	// in-app feed the attacker now controls.
	notifyNewPasskey(user.id, { name: body.name ?? null, viaRecovery: true });

	// Establish the REAL session.
	const { token, expiresAt } = createSession(user.id);
	setSessionCookie(event.cookies, token, expiresAt, event.url);
	return json({ user });
};
