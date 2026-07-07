// POST /api/auth/register/password { email, displayName, password, inviteCode? }
// Email + password registration (the default sign-up method). First user becomes
// admin. A passkey can be added later in settings.

import { json, readJson } from '$lib/server/api';
import { registerUser, createSession, setSessionCookie, AuthError, MIN_PASSWORD_LENGTH } from '$lib/server/auth';
import { sessionContextFrom } from '$lib/server/deviceTracking';
import { clientIpFor, inviteRetryAfter, noteInviteFailure, tooManyAttemptsMessage } from '$lib/server/rateLimit';
import { childLogger } from '$lib/server/logger';
import type { RequestHandler } from './$types';

const log = childLogger('auth');

export const POST: RequestHandler = async (event) => {
	const body = await readJson<{
		email?: string;
		displayName?: string;
		password?: string;
		inviteCode?: string;
	}>(event);
	const email = String(body.email ?? '');
	const displayName = String(body.displayName ?? '');
	const password = String(body.password ?? '');
	const inviteCode = String(body.inviteCode ?? '') || undefined;
	const ip = clientIpFor(event);

	if (password.length < MIN_PASSWORD_LENGTH) {
		return json(
			{ error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`, code: 'weak_password' },
			{ status: 400 }
		);
	}

	const wait = inviteRetryAfter(ip);
	if (wait !== null) return json({ error: tooManyAttemptsMessage(wait) }, { status: 429 });

	try {
		const user = registerUser({ email, displayName, password, inviteCode });
		const { token, expiresAt } = createSession(user.id, sessionContextFrom(event));
		setSessionCookie(event.cookies, token, expiresAt, event.url);
		return json({ user }, { status: 201 });
	} catch (e) {
		if (e instanceof AuthError) {
			if (e.code === 'bad_invite') noteInviteFailure(ip);
			// Invite dead-ends get a pointer to the human who can fix them (cairn-keo,
			// regressed once in the passkey refactor — see cairn-nnfj).
			const error =
				e.code === 'invite_required' || e.code === 'bad_invite'
					? `${e.message} Invites come from whoever runs this Cairn instance — ask them for a code.`
					: e.message;
			return json({ error, code: e.code }, { status: 400 });
		}
		log.error({ err: e }, 'password register failed');
		return json({ error: 'Could not create the account.' }, { status: 500 });
	}
};
