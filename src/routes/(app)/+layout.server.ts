import { redirect } from '@sveltejs/kit';
import { getUserAgreementOperator, DEFAULT_OPERATOR } from '$lib/server/disclosures';
import { getDueBackupNudge, listUnbackedWallets, shouldShowBackupReminder } from '$lib/server/backups';
import { listActiveAnnouncementsFor } from '$lib/server/announcements';
import { cachedNavBundle } from '$lib/server/navBundleCache';
import { getInstanceMode } from '$lib/server/settings';
import { httpsExternalPort } from '$lib/server/httpsPort';
import { isFirstSyncComplete } from '$lib/server/syncStatus';
import { readChainSnapshot } from '$lib/server/chainSnapshot';
import { getNetworkHealth } from '$lib/server/chainHealth';
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

	// Two separate backup nudges, plus the announcements list below, are bundled
	// behind a 15s in-process TTL cache (cairn-t72a): each is a real node:sqlite
	// query (joins/subselects, not the cheap single-keyed reads cairn-xlrm
	// already trimmed from this load), and node:sqlite is synchronous, so
	// running all three on every navigation blocks the event loop — see
	// $lib/server/navBundleCache.ts for the full rationale and why serving a
	// stale bundle for up to 15s is safe (every consumer already hides itself
	// optimistically on the client the instant it's dismissed).
	//  • backupNudge — the decaying, polymorphic "you don't have ANY backup yet"
	//    nudge (cairn-gt05.5, docs/UX-BACKUP-NUDGE-AND-FIRST-DEPOSIT-SPEC.md
	//    Spec A) that drives the layout's amber banner. getDueBackupNudge() both
	//    computes AND stamps (last_shown_at / shown_count) the one due nudge, so
	//    it's intentionally inside this cached closure: over-stamping on a 15s
	//    cache miss is harmless (decay only ever widens), and the 15s staleness
	//    just means a newly-due nudge can appear up to 15s late.
	//  • unbackedWallets — the raw (non-decayed) unbacked-wallet list, kept
	//    alongside backupNudge for consumers that need ongoing wallet HEALTH
	//    status rather than nudge-display cadence — e.g. the Home health line
	//    (cairn-md1k, src/routes/(app)/+page.svelte) — since "should we still
	//    show it" and "is it still true" are deliberately different questions.
	//  • showBackupReminder — a gentle, dismissable 90-day periodic reminder for
	//    users who HAVE backups but haven't refreshed them in a while.
	// locals.user is narrowed non-null above, but TS can't carry that narrowing
	// through the closure below (locals.user could theoretically be reassigned
	// before the closure runs), so capture the id here rather than re-reading
	// locals.user.id inside it.
	const userId = locals.user.id;
	const navBundle = cachedNavBundle(userId, () => ({
		backupNudge: getDueBackupNudge(userId),
		unbackedWallets: listUnbackedWallets(userId),
		showBackupReminder: shouldShowBackupReminder(userId),
		// Instance-wide admin announcements (active, unexpired, not dismissed by
		// this user). Gated on the announcement_banners flag right here, inside
		// the loader closure passed to cachedNavBundle — not outside it — so the
		// defense-in-depth property is unchanged: whenever this loader actually
		// runs with the flag off, the query never even runs, so nothing can
		// render no matter what the client bundle thinks. (A flag flip is only
		// reflected once the 15s TTL for this user's cache entry next expires.)
		announcements:
			locals.flags?.announcement_banners !== false ? listActiveAnnouncementsFor(userId) : []
	}));

	return {
		user: locals.user,
		// Coarse first-sync flag (cairn-2zxt.1): true once this install's
		// chain-history cache exists. Cheap — a memoized settings read, no live
		// chain call. The client renders SyncBanner (which polls /api/sync for the
		// live detail) only while this is false, so a completed sync costs nothing.
		firstSyncComplete: isFirstSyncComplete(),
		// Whether a persisted chain snapshot exists yet (cairn-6efi QA P1-a/P2-a,
		// ported from explorer/heartwood-wave2): a plain synchronous SQLite read,
		// same cost profile as isFirstSyncComplete() just above — no chain call.
		// Drives two honesty fixes: SyncBanner hides itself once real data is
		// already on screen (a "0% first sync" banner stacked above genuinely-
		// populated pages reads as a contradiction), and ChainHealthBanner's
		// "never configured" copy stops claiming data "will appear" once
		// connected when a snapshot is already showing it.
		hasChainSnapshot: readChainSnapshot() !== null,
		// Chain-transport health AT REQUEST TIME (cairn-favlc): ChainHealthBanner
		// used to be client-JS-only (onMount poll, then the live rune store below)
		// with no SSR fallback, so the very first server-rendered response after an
		// outage never contained the "can't reach your Bitcoin node" copy — a
		// hydration-less fetch (any crawler, or a slow client before JS runs) saw
		// nothing no matter how long it waited, because the client store's `health`
		// getter is hard-coded to `null` during SSR. This is the same cheap
		// in-memory union read /api/chain-health already serves, seeding the banner
		// so it's correct on the very first paint instead of only after the live
		// store's post-hydration fetch lands.
		chainHealth: getNetworkHealth(),
		// Resolved feature flags for this user, read on the client as data.flags.send
		// (etc). Server-side enforcement (requireFeature) is the real gate; this is
		// what lets the UI hide/grey features the user can't use.
		flags: locals.flags,
		// 'solo' | 'team' — drives whether multi-user nav (admin users/invites,
		// contacts, wallet sharing) is shown at all. Server-side assertTeamMode()
		// is the real gate; this is what lets the UI hide the nav entirely rather
		// than show a disabled state (docs/SOLO-MODE-UMBREL-AUTOADMIN-PLAN.md Part 2).
		// getInstanceMode() (not getInstanceSettings().instanceMode) — cairn-xlrm:
		// this load runs on every navigation, and the full getInstanceSettings()
		// pulls + decrypts core_rpc_pass for no reason when only this one field
		// is needed here.
		instanceMode: getInstanceMode(),
		// Admin-set operator name, surfaced in the sidebar chrome (cairn-ivae.6).
		// Null while still the stock fallback — "operated by the operator of this
		// Cairn instance" would be noise, so nothing renders until it's set.
		// getUserAgreementOperator() (not getUserAgreement().operator) — cairn-xlrm:
		// avoids fetching the (unused here) agreement text + version too.
		operatorName: (() => {
			const operator = getUserAgreementOperator();
			return operator === DEFAULT_OPERATOR ? null : operator;
		})(),
		backupNudge: navBundle.backupNudge,
		unbackedWallets: navBundle.unbackedWallets,
		showBackupReminder: navBundle.showBackupReminder,
		// Where Cairn's own HTTPS listener is reachable (null = not running).
		// The client uses it to offer a secure-context address for USB signing
		// when the page was loaded over plain HTTP (e.g. stock Umbrel).
		httpsPort: httpsExternalPort(),
		announcements: navBundle.announcements
	};
};
