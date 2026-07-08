// POST /api/auth/recovery/codes — mint a fresh set of 8 single-use Cairn ACCOUNT
// recovery codes for the signed-in user and return them EXACTLY ONCE.
//
// These are Cairn ACCOUNT recovery codes: each one lets you get back INTO Cairn
// (register a new passkey) if you lose access. They are NOT bitcoin keys and can
// NEVER move or reveal any bitcoin — those keys live on your hardware wallet.
//
// The plaintext codes are returned in this one response and NEVER persisted in
// the clear (recovery.ts stores only salted scrypt hashes) and NEVER logged.
// Generating a new set replaces (and invalidates) any previous set.

import { json, requireUser } from '$lib/server/api';
import { generateRecoveryCodes } from '$lib/server/recovery';
import { recordActivity } from '$lib/server/activity';
import { childLogger } from '$lib/server/logger';
import type { RequestHandler } from './$types';

const log = childLogger('recovery');

export const POST: RequestHandler = async (event) => {
	const user = requireUser(event);

	try {
		const generated = generateRecoveryCodes();
		await generated.store(user.id);
		// Record the event WITHOUT the codes — never log the codes themselves.
		recordActivity({
			type: 'account_recovery_codes_set',
			level: 'info',
			userId: user.id,
			message: 'Account recovery codes generated (previous set invalidated).'
		});
		// One and only time the plaintext leaves the server.
		return json({ codes: generated.codes });
	} catch (e) {
		log.error({ err: e, userId: user.id }, 'generate recovery codes failed');
		return json({ error: 'Could not generate recovery codes. Try again.' }, { status: 500 });
	}
};
