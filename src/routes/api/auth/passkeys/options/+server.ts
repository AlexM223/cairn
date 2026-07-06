// POST /api/auth/passkeys/options — WebAuthn creation options for a signed-in
// user to add ANOTHER passkey (phone + laptop + security key). Existing
// credentials are excluded so the same authenticator can't be added twice.

import { json, requireUser } from '$lib/server/api';
import { credentialDescriptors } from '$lib/server/auth';
import { buildRegistrationOptions, setRegChallenge } from '$lib/server/webauthn';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async (event) => {
	const user = requireUser(event);
	const exclude = credentialDescriptors(user.id);
	const options = await buildRegistrationOptions(event, {
		email: user.email,
		displayName: user.displayName,
		exclude
	});
	setRegChallenge(event, { challenge: options.challenge, userId: user.id });
	return json(options);
};
