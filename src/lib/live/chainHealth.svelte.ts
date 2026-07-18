// chainHealth — the shared live chain-transport health rune store
// (docs/LIVE-UPDATES-DESIGN.md §4.1, §5). Replaces the 15s /api/chain-health
// polls that the layout ChainHealthBanner and the Home health line each ran.
//
// The `health` frame (chainEvents.ts) is a lean {electrum, tipHeight, tipAgeMs}
// signal — it can't reconstruct the authoritative verdict the banner renders,
// which is a UNION across backends (an Electrum outage is NOT "network down"
// when Core RPC still serves the explorer) plus the neverConfigured / proxy
// context (getNetworkHealth). So this store treats each frame as a NUDGE and
// re-reads /api/chain-health — the same cheap in-memory server signal the poll
// read, now fired only on a real transport transition instead of every 15s.
//
// It seeds with one fetch on first use so the banner isn't blind before the
// first frame (frames fire on connect/disconnect, which may be rare on a healthy
// instance). Lazy + SSR-safe like the other live stores.

import { subscribe } from './liveClient';
import type { ChainHealth } from '$lib/server/chainHealth';

const REFETCH_DEBOUNCE_MS = 400;

let health = $state<ChainHealth | null>(null);
let started = false;
let refetchTimer: ReturnType<typeof setTimeout> | null = null;

async function fetchHealth(): Promise<void> {
	try {
		const res = await fetch('/api/chain-health', { cache: 'no-store' });
		if (res.ok) health = (await res.json()) as ChainHealth;
	} catch {
		// A missed read is fine — keep the last-known verdict; the next nudge
		// (or the seed) catches up.
	}
}

/** Coalesce a burst of `health` frames (e.g. a flapping transport) into one
 *  authoritative re-read. */
function scheduleRefetch(): void {
	if (refetchTimer !== null) return;
	refetchTimer = setTimeout(() => {
		refetchTimer = null;
		void fetchHealth();
	}, REFETCH_DEBOUNCE_MS);
}

function ensureStarted(): void {
	if (started) return;
	started = true;
	void fetchHealth(); // seed so the banner has a verdict before the first frame
	subscribe('health', () => scheduleRefetch());
}

/** The shared live transport health, or null before the seed lands. Reading
 *  `.health` lazily seeds it and arms the `health` subscription. SSR-safe:
 *  returns null on the server (no fetch, no subscription). */
export const chainHealth = {
	get health(): ChainHealth | null {
		if (typeof window === 'undefined') return null;
		ensureStarted();
		return health;
	}
};
