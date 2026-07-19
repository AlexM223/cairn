import { userCount } from '$lib/server/auth';
import { getInstanceSettings } from '$lib/server/settings';
import { getInvitePreview, inviteNodeTitle } from '$lib/server/invitePreview';
import { clientIpFor, inviteRetryAfter, noteInviteFailure } from '$lib/server/rateLimit';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async (event) => {
	const { url } = event;
	const firstUser = userCount() === 0;
	const mode = getInstanceSettings().registrationMode;

	// Prefill the invite field when arriving via an invite link
	// (/signup?invite=CAIRN-XXXX-XXXX).
	const invite = url.searchParams.get('invite') ?? '';

	// Come-aboard branding (cairn-95yic): when the prefilled code is currently
	// redeemable, the signup page introduces the node it belongs to ("Joining
	// Alex's node") instead of reading like a generic SaaS form. Same leak
	// contract and the SAME per-IP rate-limit budget as /invite/[code] — a
	// GET with a bad code counts as an enumeration miss here too, so this
	// load opens no probe surface the landing page didn't already meter.
	let invitePreview = null;
	let inviteNode: string | null = null;
	if (invite && !firstUser) {
		const ip = clientIpFor(event);
		if (inviteRetryAfter(ip) === null) {
			invitePreview = getInvitePreview(invite);
			if (invitePreview) inviteNode = inviteNodeTitle(invitePreview);
			else noteInviteFailure(ip);
		}
	}

	return {
		firstUser,
		registrationMode: mode,
		needsInvite: !firstUser && mode === 'invite',
		closed: !firstUser && mode === 'closed',
		invite,
		// null unless the prefilled code is valid right now. Only the node
		// title + captain name are consumed by the page; the full preview is
		// passed so the welcome message can ride along too.
		invitePreview,
		inviteNode
	};
};

// Registration is a passkey ceremony driven client-side against
// /api/auth/register/{options,verify} — there is no form action here.
