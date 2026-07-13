// Gate the entire /explorer section (index + address/block/tx/mempool/difficulty
// sub-routes) behind the `explorer` feature flag. A layout load runs for every
// child page, so this one guard covers direct navigation to any explorer URL —
// the enforcement boundary the per-page nav-hiding in §4 is only a courtesy for.
import { requireFeature } from '$lib/server/api';
import { readChainSnapshot } from '$lib/server/chainSnapshot';
import { gatherNodeTrust } from '$lib/server/chain/nodeTrust';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = async (event) => {
	requireFeature(event, 'explorer');

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
