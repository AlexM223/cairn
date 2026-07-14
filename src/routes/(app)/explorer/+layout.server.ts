// Gate the /explorer section (index + address/block/mempool/difficulty
// sub-routes) behind the `explorer` feature flag. A layout load runs for every
// child page, so this one guard covers direct navigation to any explorer URL —
// the enforcement boundary the per-page nav-hiding in §4 is only a courtesy for.
//
// EXCEPTION (cairn-5yz3.3): /explorer/tx/[txid] is exempt from the flag gate.
// Every tx surface app-wide (dashboard RecentActivity, /activity, wallet-detail
// rows) links to this one route for transaction detail — it's the only
// tx-detail view that exists. Gating it behind `explorer` meant an
// explorer-off instance had NO way to open a transaction: every tx link in the
// app degrades to an inert row (see RecentActivity.svelte) with nowhere to
// land. The tx page itself never does explorer-style chain *browsing* (no
// block list, no mempool view, no address search) — it's a single
// transaction's detail, reachable only by already knowing its txid — so
// serving it without the explorer flag doesn't reopen any browsing surface.
// Still requires a logged-in user like the rest of the app.
import { requireFeature, requireUser } from '$lib/server/api';
import { readChainSnapshot } from '$lib/server/chainSnapshot';
import { gatherNodeTrust } from '$lib/server/chain/nodeTrust';
import type { LayoutServerLoad } from './$types';

const TX_DETAIL_ROUTE_ID = '/(app)/explorer/tx/[txid]';

export const load: LayoutServerLoad = async (event) => {
	if (event.route.id === TX_DETAIL_ROUTE_ID) {
		requireUser(event);
	} else {
		requireFeature(event, 'explorer');
	}

	// Snapshot provenance (cairn-6efi QA P1-a, ported from explorer/heartwood-wave2):
	// when the chain transport is disconnected that does NOT mean "no data" — the
	// persisted snapshot may still be showing (possibly stale) numbers. Every
	// explorer sub-route already renders its own NodeTrustChip from its own page
	// load, each backed by gatherNodeTrust() (cairn-6efi.3: synchronous, cached,
	// no chain call — unlike the superseded branch's streamed getNodeTrust()
	// promise, so no streaming is needed here either). This shared layout load
	// adds just the caption's two inputs — snapshotAt and whether the transport
	// is disconnected — cheaply, so the explorer-wide caption stays correct on
	// every sub-route without duplicating any page's own chip.
	const trust = gatherNodeTrust();
	return {
		snapshotAt: readChainSnapshot()?.lastSyncedAt ?? null,
		disconnected: !trust.connected
	};
};
