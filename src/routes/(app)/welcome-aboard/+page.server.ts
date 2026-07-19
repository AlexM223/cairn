// Guided first run for invited crew (come-aboard, cairn-sr5ry). Reached from
// the signup page after a successful invite redemption — deliberately NOT the
// generic "set up your own node" first run: this user is joining someone
// else's node, and the sequence explains what that means. Lives in the (app)
// group so the auth/agreement gates apply as normal; harmless to open by
// hand for any signed-in user (it's a tour, not a state machine).

import { getInstanceName } from '$lib/server/admin';
import { db } from '$lib/server/db';
import { listSharedMultisigs } from '$lib/server/multisigShares';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	// Node title fallback chain mirrors invitePreview.ts's inviteNodeTitle:
	// admin-set name, else the earliest admin's name, else neutral.
	let nodeTitle = getInstanceName();
	if (!nodeTitle) {
		const captain = db
			.prepare('SELECT display_name FROM users WHERE is_admin = 1 ORDER BY created_at ASC LIMIT 1')
			.get() as { display_name: string } | undefined;
		nodeTitle = captain ? `${captain.display_name}'s node` : 'this node';
	}

	// Personalize the shared-wallet beat: someone invited to cosign before
	// their first login should hear "it's already waiting for you".
	const sharedWallets = locals.user ? listSharedMultisigs(locals.user.id).length : 0;

	return { nodeTitle, sharedWallets };
};
