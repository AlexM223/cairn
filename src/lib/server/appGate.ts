// Pure redirect-target resolver for the (app) route group's four access
// gates (cairn-v84z). These used to live inline in (app)/+layout.server.ts's
// load(), which read `url.pathname` to compute them — but SvelteKit
// re-invokes ("un-caches") a server layout load on every client-side
// navigation as soon as it reads a `url`/`params` property, so that one read
// turned the layout's ~13-15 sequential SQLite queries into a full server
// round trip on EVERY nav, not just full document loads. Moving the gates
// here lets hooks.server.ts run them ONCE per request (from event.url,
// which the hook always has fresh) while the layout load itself becomes a
// pure `locals` read that SvelteKit can cache across navigations.
//
// Order and semantics are copied from the original layout load verbatim —
// see that file's history for the per-gate rationale comments this file
// intentionally keeps close to:
//   1. no session -> /login (?next=<pathname> unless pathname is '/')
//   2. forced credential reset (cairn-49xi.2) -> /setup-admin
//   3. disclosure/agreement gate -> /disclosure (admin) or /agreement (else)
//   4. recovery gate (admin only, skipped on /recovery-setup itself) -> /recovery-setup
//
// Returns the first matching redirect target, or null if the request should
// proceed normally. Deliberately has NO SvelteKit imports (no `redirect()`
// throw) so it stays a plain, synchronously-testable function — the caller
// decides how to act on the target (throw a redirect for GET/HEAD, or fail
// non-GET/HEAD requests with a plain error(), since a thrown redirect breaks
// use:enhance's applyAction for form actions).
import { mustResetPassword } from '$lib/server/auth';
import { hasAcceptedAdminDisclosure, hasAcceptedCurrentAgreement } from '$lib/server/disclosures';
import { hasRecoverySetup } from '$lib/server/recovery';
import type { SessionUser } from '$lib/types';

export function appGateRedirect(user: SessionUser | null, pathname: string): string | null {
	if (!user) {
		const next = pathname === '/' ? '' : `?next=${encodeURIComponent(pathname)}`;
		return `/login${next}`;
	}

	// Forced credential-reset gate (cairn-49xi.2) — FIRST, before every other
	// gate: a bootstrap-created admin's password came from a deployment env
	// var that stays visible in the platform's install UI/logs, and their
	// email is a placeholder that can't receive notifications. Until they
	// choose their own at /setup-admin (top-level, outside the (app) group,
	// so this can't loop), they shouldn't be accepting disclosures or setting
	// up recovery either.
	if (mustResetPassword(user.id)) return '/setup-admin';

	// Disclosure gates. The acceptance screens live at top-level /disclosure
	// and /agreement (outside the (app) group), so redirecting here can't loop.
	//  • The operator (admin) must accept the one-time infrastructure disclosure
	//    before doing anything on the instance — including inviting users.
	//  • Every other user must accept the current user agreement; a version
	//    bump (the admin edited the terms) re-gates them on their next visit.
	if (user.isAdmin) {
		if (!hasAcceptedAdminDisclosure(user.id)) return '/disclosure';
	} else if (!hasAcceptedCurrentAgreement(user.id)) {
		return '/agreement';
	}

	// Recovery gate. Account recovery is MANDATORY for the admin (the instance
	// operator must stay recoverable), so an admin with incomplete recovery is
	// forced back to the setup wizard from any other app route. The wizard
	// itself lives under the (app) group at /recovery-setup, so skip the gate
	// there to avoid a redirect loop. Runs AFTER the disclosure gate so the
	// admin accepts the disclosure first, then lands on recovery-setup on the
	// next request.
	if (user.isAdmin && pathname !== '/recovery-setup') {
		const status = hasRecoverySetup(user.id);
		const recoveryComplete = status.phrase && status.codesRemaining > 0;
		if (!recoveryComplete) return '/recovery-setup';
	}

	return null;
}
