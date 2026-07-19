// Public invite landing (come-aboard flagship, cairn-n1ovc). Top-level route —
// outside the (app) gate on purpose: the whole point is what a not-yet-user
// sees when they open an invite link from their captain.
//
// Leak audit: everything returned here comes from getInvitePreview()
// (src/lib/server/invitePreview.ts), whose header documents the exact exposed
// field list and the null-on-invalid contract. This load adds only `code`
// (which the caller already has — it's in their URL) and `signedIn`.
//
// Rate limiting: misses count against the SAME per-IP invite buckets signup
// uses (rateLimit.ts LIMITS.invitesIp), so this page adds zero new
// enumeration budget. A throttled or invalid lookup renders the same calm
// "not active" state — with `throttled` set only so the copy can honestly
// say "try again in a bit" instead of implying the code is dead.

import { getInvitePreview, inviteNodeTitle } from '$lib/server/invitePreview';
import { clientIpFor, inviteRetryAfter, noteInviteFailure } from '$lib/server/rateLimit';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async (event) => {
	const code = event.params.code;
	const signedIn = !!event.locals.user;
	const ip = clientIpFor(event);

	if (inviteRetryAfter(ip) !== null) {
		return { code, signedIn, preview: null, nodeTitle: null, throttled: true };
	}

	const preview = getInvitePreview(code);
	if (!preview) {
		noteInviteFailure(ip);
		return { code, signedIn, preview: null, nodeTitle: null, throttled: false };
	}

	return {
		code,
		signedIn,
		preview,
		nodeTitle: inviteNodeTitle(preview),
		throttled: false
	};
};
