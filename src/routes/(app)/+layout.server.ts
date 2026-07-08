import { redirect } from '@sveltejs/kit';
import { getUserAgreement, DEFAULT_OPERATOR } from '$lib/server/disclosures';
import { listUnbackedWallets, shouldShowBackupReminder } from '$lib/server/backups';
import { listActiveAnnouncementsFor } from '$lib/server/announcements';
import { getInstanceSettings } from '$lib/server/settings';
import { httpsExternalPort } from '$lib/server/httpsPort';
import { isFirstSyncComplete } from '$lib/server/syncStatus';
import type { LayoutServerLoad } from './$types';

// cairn-v84z — this load intentionally reads ONLY `locals` (no `url`,
// `params`, `depends`, or `fetch`). A server load with none of those tracked
// dependencies is cacheable across client-side navigations; this load used
// to read `url.pathname` for its four access gates, which made SvelteKit
// re-invoke it — a full server round trip through ~13-15 sequential SQLite
// queries — on essentially every nav instead of just full document loads.
// The four gates (auth / forced-reset / disclosure-agreement / recovery)
// moved to hooks.server.ts's handle(), which calls appGateRedirect() with
// the always-fresh event.url on every request BEFORE this load ever runs —
// see src/lib/server/appGate.ts for the gate logic, ordering, and the
// per-gate rationale comments that used to live here.
export const load: LayoutServerLoad = async ({ locals }) => {
	// Belt-and-braces only: hooks.server.ts's (app)-scoped gate guarantees
	// locals.user is set before this load runs, so this branch should be
	// unreachable in production. Kept as a minimal type-narrowing fallback —
	// redirecting to a plain '/login' (no ?next=, which would require reading
	// url) keeps this load free of tracked dependencies, per the comment above.
	if (!locals.user) {
		redirect(302, '/login');
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
