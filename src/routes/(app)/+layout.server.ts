import { redirect } from '@sveltejs/kit';
import {
	hasAcceptedAdminDisclosure,
	hasAcceptedCurrentAgreement
} from '$lib/server/disclosures';
import { hasRecoverySetup } from '$lib/server/recovery';
import { listUnbackedWallets, shouldShowBackupReminder } from '$lib/server/backups';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = async ({ locals, url }) => {
	if (!locals.user) {
		const next = url.pathname === '/' ? '' : `?next=${encodeURIComponent(url.pathname)}`;
		redirect(302, `/login${next}`);
	}

	// Disclosure gates. The acceptance screens live at top-level /disclosure and
	// /agreement (outside this layout), so redirecting here can't loop.
	//  • The operator (admin) must accept the one-time infrastructure disclosure
	//    before doing anything on the instance — including inviting users.
	//  • Every other user must accept the current user agreement; a version bump
	//    (the admin edited the terms) re-gates them on their next visit.
	if (locals.user.isAdmin) {
		if (!hasAcceptedAdminDisclosure(locals.user.id)) redirect(302, '/disclosure');
	} else if (!hasAcceptedCurrentAgreement(locals.user.id)) {
		redirect(302, '/agreement');
	}

	// Recovery gate. Account recovery is MANDATORY for the admin (the instance
	// operator must stay recoverable), so an admin with incomplete recovery is
	// forced back to the setup wizard from any other app route. The wizard itself
	// lives under this layout at /recovery-setup, so skip the gate there to avoid
	// a redirect loop. Runs AFTER the disclosure gate so the admin accepts the
	// disclosure first, then lands on recovery-setup on the next request.
	if (locals.user.isAdmin && url.pathname !== '/recovery-setup') {
		const status = hasRecoverySetup(locals.user.id);
		const recoveryComplete = status.phrase && status.codesRemaining > 0;
		if (!recoveryComplete) redirect(302, '/recovery-setup');
	}

	// Two separate backup nudges:
	//  • unbackedWallets — wallets whose config has NEVER been downloaded (a lost
	//    config can mean permanently lost funds, so this stays until resolved).
	//  • showBackupReminder — a gentle, dismissable 90-day periodic reminder for
	//    users who HAVE backups but haven't refreshed them in a while.
	// Both are cheap local SQLite reads.
	return {
		user: locals.user,
		// Resolved feature flags for this user, read on the client as data.flags.send
		// (etc). Server-side enforcement (requireFeature) is the real gate; this is
		// what lets the UI hide/grey features the user can't use.
		flags: locals.flags,
		unbackedWallets: listUnbackedWallets(locals.user.id),
		showBackupReminder: shouldShowBackupReminder(locals.user.id)
	};
};
