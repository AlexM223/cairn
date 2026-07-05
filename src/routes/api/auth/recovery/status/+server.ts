// GET /api/auth/recovery/status — the signed-in user's recovery-setup state.
//
// ACCOUNT recovery (getting back INTO Cairn) — NOT bitcoin. This only reports
// whether the user has a Cairn recovery phrase and how many one-time recovery
// codes remain. It never returns a secret.

import { json, requireUser } from '$lib/server/api';
import { hasRecoverySetup } from '$lib/server/recovery';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = (event) => {
	const user = requireUser(event);
	const { phrase, codesRemaining } = hasRecoverySetup(user.id);
	return json({ phrase, codesRemaining, complete: phrase && codesRemaining > 0 });
};
