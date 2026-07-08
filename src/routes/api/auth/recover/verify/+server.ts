// POST /api/auth/recover/verify  { email, phrase?, code? }
//
// ACCOUNT recovery — getting back INTO Cairn (the LOGIN) after losing every
// passkey. This has NOTHING to do with bitcoin: a Cairn recovery phrase or code
// restores login only and can never move or reveal bitcoin (whose keys live on
// the hardware wallet).
//
// Verifies either a recovery PHRASE or a one-time recovery CODE for the account
// with `email`. On success it mints a short-lived, single-purpose RECOVERY GRANT
// (an httpOnly cookie) that authorizes ONLY registering a new passkey — NOT full
// app access. The client then runs the passkey-registration ceremony against the
// recover/register routes, which turn the grant into a real session.
//
// No user-enumeration: the response for an unknown email, a wrong phrase, and a
// wrong code is byte-for-byte identical (same status, same generic message), and
// a dummy scrypt verify is run when the user or secret is absent so timing does
// not reveal whether the account exists.

import { json, readJson } from '$lib/server/api';
import { getUserByEmail } from '$lib/server/auth';
import {
	verifyRecoveryPhrase,
	consumeRecoveryCode,
	dummyVerify,
	createRecoveryGrant,
	RECOVERY_GRANT_COOKIE,
	RECOVERY_GRANT_TTL_MS
} from '$lib/server/recovery';
import {
	clientIpFor,
	recoveryRetryAfter,
	noteRecoveryAttempt,
	tooManyAttemptsMessage
} from '$lib/server/rateLimit';
import { recordActivity } from '$lib/server/activity';
import { childLogger } from '$lib/server/logger';
import type { RequestHandler } from './$types';

const log = childLogger('recovery');

// One generic outcome for every failure — never reveals which of email / phrase
// / code was wrong, nor whether the account exists.
const GENERIC_FAILURE = {
	error: 'That recovery information did not match. Check it and try again.'
};

export const POST: RequestHandler = async (event) => {
	const body = await readJson<{ email?: string; phrase?: string; code?: string }>(event);
	const email = String(body.email ?? '');
	const phrase = body.phrase != null ? String(body.phrase) : undefined;
	const code = body.code != null ? String(body.code) : undefined;
	const ip = clientIpFor(event);

	// Rate limit on BOTH email and IP (5/hour), before touching the DB.
	const wait = recoveryRetryAfter(ip, email);
	if (wait !== null) return json({ error: tooManyAttemptsMessage(wait) }, { status: 429 });
	// Every attempt counts toward the cap (success or failure).
	noteRecoveryAttempt(ip, email);

	// Must supply exactly one secret. Still burn a dummy verify so a
	// missing-secret probe costs the same as a real attempt.
	const hasPhrase = typeof phrase === 'string' && phrase.trim().length > 0;
	const hasCode = typeof code === 'string' && code.trim().length > 0;
	if (hasPhrase === hasCode) {
		await dummyVerify(phrase ?? code ?? '');
		return json(GENERIC_FAILURE, { status: 400 });
	}

	const user = getUserByEmail(email);

	// Absent user → dummy verify (constant-time), same generic failure.
	if (!user) {
		await dummyVerify(phrase ?? code ?? '');
		return json(GENERIC_FAILURE, { status: 401 });
	}

	let ok = false;
	if (hasPhrase) {
		// A phrase is reusable — verifying does not consume it.
		ok = await verifyRecoveryPhrase(user.id, phrase!);
	} else {
		// A code is single-use — consuming marks it used, even on success.
		ok = await consumeRecoveryCode(user.id, code!);
	}

	if (!ok) return json(GENERIC_FAILURE, { status: 401 });

	// Success: mint the single-purpose recovery grant and set it as an httpOnly
	// cookie. This authorizes ONLY registering a new passkey (recover/register).
	const { token, expiresAt } = createRecoveryGrant(user.id);
	event.cookies.set(RECOVERY_GRANT_COOKIE, token, {
		path: '/',
		httpOnly: true,
		sameSite: 'lax',
		secure: event.url.protocol === 'https:',
		maxAge: Math.floor(RECOVERY_GRANT_TTL_MS / 1000)
	});

	log.info({ userId: user.id, method: hasPhrase ? 'phrase' : 'code' }, 'account recovery verified');
	recordActivity({
		type: 'account_recovery',
		level: 'warn',
		userId: user.id,
		message: `Account recovery verified with a recovery ${hasPhrase ? 'phrase' : 'code'}. Register a new passkey to finish.`
	});

	// Do not echo the email back beyond what the client already sent; return the
	// display name so the register step can show a friendly prompt.
	return json({
		ok: true,
		user: { email: user.email, displayName: user.displayName },
		grantExpiresAt: expiresAt.toISOString()
	});
};
