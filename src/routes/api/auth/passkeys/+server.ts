// GET  /api/auth/passkeys        — list the signed-in user's passkeys
// POST /api/auth/passkeys {response, name?} — verify + store a newly added passkey

import { json, requireUser, readJson } from '$lib/server/api';
import { listCredentials, addCredential, credentialExists } from '$lib/server/auth';
import { verifyRegistration, readRegChallenge, clearRegChallenge } from '$lib/server/webauthn';
import { childLogger } from '$lib/server/logger';
import type { RegistrationResponseJSON } from '@simplewebauthn/server';
import type { RequestHandler } from './$types';

const log = childLogger('auth');

export const GET: RequestHandler = (event) => {
	const user = requireUser(event);
	return json({ passkeys: listCredentials(user.id) });
};

export const POST: RequestHandler = async (event) => {
	const user = requireUser(event);
	const body = await readJson<{ response?: RegistrationResponseJSON; name?: string }>(event);
	const pending = readRegChallenge(event);

	// Must be an add-passkey ceremony for THIS user.
	if (!pending || pending.userId !== user.id || !body.response) {
		return json({ error: 'Passkey session expired. Start again.' }, { status: 400 });
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
	if (credentialExists(credential.id)) {
		clearRegChallenge(event);
		return json({ error: 'That passkey is already registered.' }, { status: 400 });
	}

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
		clearRegChallenge(event);
		log.error({ err: e, userId: user.id }, 'add passkey failed');
		return json({ error: 'Could not save the passkey.' }, { status: 500 });
	}

	clearRegChallenge(event);
	return json({ passkeys: listCredentials(user.id) }, { status: 201 });
};
