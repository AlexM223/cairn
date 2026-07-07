import { redirect } from '@sveltejs/kit';
import {
	hasAcceptedAdminDisclosure,
	hasAcceptedCurrentAgreement,
	getUserAgreement,
	DEFAULT_OPERATOR
} from '$lib/server/disclosures';
import { hasRecoverySetup } from '$lib/server/recovery';
import { mustResetPassword } from '$lib/server/auth';
import { listUnbackedWallets, shouldShowBackupReminder } from '$lib/server/backups';
import { listActiveAnnouncementsFor } from '$lib/server/announcements';
import { getInstanceSettings } from '$lib/server/settings';
import { httpsExternalPort } from '$lib/server/httpsPort';
import { isFirstSyncComplete } from '$lib/server/syncStatus';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = async ({ locals, url }) => {
	if (!locals.user) {
		const next = url.pathname === '/' ? '' : `?next=${encodeURIComponent(url.pathname)}`;
		redirect(302, `/login${next}`);
	}

	// Forced credential-reset gate (cairn-49xi.2) — FIRST, before every other
	// gate: a bootstrap-created admin's password came from a deployment env var
	// that stays visible in the platform's install UI/logs, and their email is a
	// placeholder that can't receive notifications. Until they choose their own
	// at /setup-admin (top-level, outside this layout, so this can't loop), they
	// shouldn't be accepting disclosures or setting up recovery either.
	if (mustResetPassword(locals.user.id)) redirect(302, '/setup-admin');

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

	// First-sync is NON-BLOCKING (cairn-2zxt.1). We used to redirect every app
	// route to the full-screen /sync experience until the once-per-install
	// chain-history cache existed — but a full-screen gate traps users behind a
	// blocking page on first install, and its "continue without waiting" escape
	// cookie proved unreliable (it's set on the plain-HTTP origin, then the
	// secure auto-hop in secureRedirect.ts throws the user onto the HTTPS origin
	// where the just-set cookie doesn't reliably carry, bouncing them right back
	// to /sync). So the gate is gone entirely: every route renders immediately.
	// We thread only the coarse, cheap boolean here (a memoized settings read —
	// NO Electrum tip lookup); the non-blocking SyncBanner in (app)/+layout.svelte
	// polls /api/sync client-side for live phase/ring/ETA detail, exactly the way
	// the /sync page does. /sync stays reachable as an optional "view details"
	// page, linked from the banner, but nobody is redirected there involuntarily.

	// Two separate backup nudges:
	//  • unbackedWallets — wallets whose config has NEVER been downloaded (a lost
	//    config can mean permanently lost funds, so this stays until resolved).
	//  • showBackupReminder — a gentle, dismissable 90-day periodic reminder for
	//    users who HAVE backups but haven't refreshed them in a while.
	// Both are cheap local SQLite reads.
	return {
		user: locals.user,
		// Coarse first-sync flag (cairn-2zxt.1): true once this install's
		// chain-history cache exists. Cheap — a memoized settings read, no live
		// chain call. The client renders SyncBanner (which polls /api/sync for the
		// live detail) only while this is false, so a completed sync costs nothing.
		firstSyncComplete: isFirstSyncComplete(),
		// Resolved feature flags for this user, read on the client as data.flags.send
		// (etc). Server-side enforcement (requireFeature) is the real gate; this is
		// what lets the UI hide/grey features the user can't use.
		flags: locals.flags,
		// 'solo' | 'team' — drives whether multi-user nav (admin users/invites,
		// contacts, wallet sharing) is shown at all. Server-side assertTeamMode()
		// is the real gate; this is what lets the UI hide the nav entirely rather
		// than show a disabled state (docs/SOLO-MODE-UMBREL-AUTOADMIN-PLAN.md Part 2).
		instanceMode: getInstanceSettings().instanceMode,
		// Admin-set operator name, surfaced in the sidebar chrome (cairn-ivae.6).
		// Null while still the stock fallback — "operated by the operator of this
		// Cairn instance" would be noise, so nothing renders until it's set.
		operatorName: (() => {
			const operator = getUserAgreement().operator;
			return operator === DEFAULT_OPERATOR ? null : operator;
		})(),
		unbackedWallets: listUnbackedWallets(locals.user.id),
		showBackupReminder: shouldShowBackupReminder(locals.user.id),
		// Where Cairn's own HTTPS listener is reachable (null = not running).
		// The client uses it to offer a secure-context address for USB signing
		// when the page was loaded over plain HTTP (e.g. stock Umbrel).
		httpsPort: httpsExternalPort(),
		// Instance-wide admin announcements (active, unexpired, not dismissed by
		// this user). Gated on the announcement_banners flag: off → none load, so
		// nothing renders no matter what the client bundle thinks.
		announcements:
			locals.flags?.announcement_banners !== false
				? listActiveAnnouncementsFor(locals.user.id)
				: []
	};
};
