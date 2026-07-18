// mempoolStats — the shared live mempool rune store (docs/LIVE-UPDATES-DESIGN.md
// §4.1). Fed by the broadcast `mempool` frames the process-level ticker
// (liveTickers.ts) publishes at most every 5s, on change only.
//
// Payload-driven (§4.2): the frame carries the cheap, self-contained mempool
// figures — waiting-tx count, total vsize, the fee histogram, and the projected
// next-blocks view — so counters and the fee-distribution ridge update straight
// off the payload with no fetch. Heavier server-recomputed fields a mempool page
// also shows (fee estimates, backlog trend, total waiting fees) are NOT in the
// frame; those pages pair this store with a debounced tag-scoped reload for the
// rest (§4.2).
//
// Lazy + SSR-safe, mirroring tipHeight.svelte.ts: the `mempool` subscription is
// armed on first read of `.stats`, and liveClient's subscribe() no-ops off the
// browser, so importing this module never opens a connection.

import { subscribe } from './liveClient';
import type { FeeHistogram, MempoolBlockProjection } from '$lib/types';

/** The `mempool` frame payload (§2 taxonomy). Counters are nullable: a
 *  single-backend deploy (Electrum-only, no Core) has a fee histogram but no
 *  Core-sourced summary, so `count`/`vsizeVb` can be null while `feeHistogram`
 *  is present, and vice versa. */
export interface MempoolStats {
	count: number | null;
	vsizeVb: number | null;
	feeHistogram: FeeHistogram | null;
	mempoolBlocks: MempoolBlockProjection[] | null;
	updatedAt: number;
}

let stats = $state<MempoolStats | null>(null);
let started = false;

function ensureStarted(): void {
	if (started) return;
	started = true;
	subscribe('mempool', (ev) => {
		try {
			stats = JSON.parse(ev.data as string) as MempoolStats;
		} catch {
			// Malformed frame — keep the last-known snapshot.
		}
	});
}

/** The shared live mempool snapshot, or null before the first frame. Reading
 *  `.stats` lazily arms the `mempool` subscription. */
export const mempoolStats = {
	get stats(): MempoolStats | null {
		ensureStarted();
		return stats;
	}
};
