// Come-aboard invite preview (cairn-n1ovc) — the server slice behind the
// public /invite/[code] landing page and the branded signup header.
//
// SECURITY CONTRACT (audited; extend the field list ONLY with review):
// this module is reachable WITHOUT authentication by anyone holding an
// invite link, and /invite/[code] URLs travel over chat apps and email. So:
//
//   1. A code that is not currently redeemable (unknown, revoked, expired,
//      or exhausted — indistinguishable from each other) returns null and
//      reveals NOTHING about the instance: no name, no status, not even
//      whether the code ever existed.
//   2. For a redeemable code, the preview exposes EXACTLY these fields:
//        instanceName    admin-set node name (admin wrote it for this purpose)
//        captainName     display name of the admin who created THIS invite
//                        (they are introducing themselves to their invitee)
//        welcomeMessage  captain-written text attached to THIS invite
//        watching        boolean — chain transport currently healthy
//        synced          boolean — one-time chain-history sync finished
//        tipHeight       latest block height from the PERSISTED snapshot
//                        (public chain data; a synchronous read, never a
//                        live chain call on this unauthenticated path)
//        sharedSurfaces  instance-level explorer/mining flag booleans
//      Never: balances, addresses, xpubs, wallet names or counts, user
//      counts or emails, other invites, the invite's admin bookkeeping
//      (label, uses, expiry), or Electrum/Core endpoint details.
//   3. Lookups are rate-limited by the CALLER (the route) via the existing
//      invite buckets in rateLimit.ts — same budget as signup's code field,
//      so this page adds no new enumeration surface beyond what signup
//      already allowed. Codes are 8 chars from a 31-char alphabet on top.
//
// invitePreview.test.ts pins both the null-on-invalid behavior and the
// exact exposed-field list; a new field failing that test is the review
// gate working, not an obstacle to route around.

import { db } from './db';
import { redeemableInviteId } from './auth';
import { getInstanceName } from './admin';
import { getNetworkHealth } from './chainHealth';
import { isFirstSyncComplete } from './syncStatus';
import { readChainSnapshot } from './chainSnapshot';
import { isFeatureEnabled } from './featureFlags/resolve';

export interface InvitePreview {
	instanceName: string | null;
	captainName: string | null;
	welcomeMessage: string | null;
	watching: boolean;
	synced: boolean;
	tipHeight: number | null;
	sharedSurfaces: { explorer: boolean; mining: boolean };
}

/**
 * The landing-page preview for an invite code, or null when the code is not
 * currently redeemable (see the security contract above). Cheap and fully
 * synchronous reads only — safe to run per-request on an unauthenticated
 * route (the route additionally rate-limits misses).
 */
export function getInvitePreview(code: string): InvitePreview | null {
	const trimmed = code.trim();
	if (!trimmed || trimmed.length > 64) return null;

	const inviteId = redeemableInviteId(trimmed);
	if (inviteId === null) return null;

	const row = db
		.prepare(
			`SELECT i.welcome_message, u.display_name AS captain_name
			 FROM invites i LEFT JOIN users u ON u.id = i.created_by
			 WHERE i.id = ?`
		)
		.get(inviteId) as { welcome_message: string | null; captain_name: string | null } | undefined;

	return {
		instanceName: getInstanceName(),
		captainName: row?.captain_name ?? null,
		welcomeMessage: row?.welcome_message ?? null,
		watching: getNetworkHealth().healthy,
		synced: isFirstSyncComplete(),
		tipHeight: readChainSnapshot()?.data.tipHeight ?? null,
		sharedSurfaces: {
			// Instance-level resolution (userId null): there is no user yet.
			explorer: isFeatureEnabled('explorer', null),
			mining: isFeatureEnabled('mining', null)
		}
	};
}

/**
 * The one line the landing page leads with. Fallback chain: the admin-set
 * node name, else "[captain]'s node", else a neutral generic — never blank.
 */
export function inviteNodeTitle(p: InvitePreview): string {
	if (p.instanceName) return p.instanceName;
	if (p.captainName) return `${p.captainName}'s node`;
	return 'a Heartwood node';
}
