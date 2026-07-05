// POST /api/auth/recovery/phrase — mint a fresh Cairn ACCOUNT recovery phrase
// for the signed-in user and return it EXACTLY ONCE.
//
// This is a Cairn ACCOUNT recovery phrase: it restores your LOGIN if you lose
// every passkey. It is NOT a bitcoin key and can NEVER move or reveal any
// bitcoin — those keys live on your hardware wallet.
//
// The plaintext phrase is returned in this one response and NEVER persisted in
// the clear (recovery.ts stores only a salted scrypt hash) and NEVER logged.
// Generating a new phrase replaces any previous one.

import { json, requireUser } from '$lib/server/api';
import { generateRecoveryPhrase } from '$lib/server/recovery';
import { recordActivity } from '$lib/server/activity';
import { childLogger } from '$lib/server/logger';
import type { RequestHandler } from './$types';

const log = childLogger('recovery');

export const POST: RequestHandler = (event) => {
	const user = requireUser(event);

	try {
		const generated = generateRecoveryPhrase();
		generated.store(user.id);
		// Record the event WITHOUT the secret — never log the phrase itself.
		recordActivity({
			type: 'account_recovery_phrase_set',
			level: 'info',
			userId: user.id,
			message: 'Account recovery phrase generated.'
		});
		// One and only time the plaintext leaves the server.
		return json({ phrase: generated.phrase });
	} catch (e) {
		log.error({ err: e, userId: user.id }, 'generate recovery phrase failed');
		return json({ error: 'Could not generate a recovery phrase. Try again.' }, { status: 500 });
	}
};
