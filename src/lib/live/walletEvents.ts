// walletEvents — the client-side consumption helper for the user-scoped `wallet`
// topic (docs/LIVE-UPDATES-DESIGN.md §2, §4.2). addressWatcher publishes a
// `wallet` frame next to each tx notification (received / large / confirmed /
// replaced); this module turns those raw SSE frames into typed callbacks and
// provides the shared debounce every consumer uses to collapse a burst of frames
// (a single block touching many addresses) into ONE reload (§4.2, ~800ms).
//
// Per the payload-vs-invalidate rule (§4.2), the `wallet` topic is
// invalidate-driven: the frame is a nudge, not a source of truth. Consumers
// react by re-running their tag-scoped load (or the equivalent client-side
// refresh) — they never render balances/tx-lists directly off this payload.

import { subscribe } from './liveClient';

/** The `wallet` frame payload (§2 taxonomy). `txid`/`amountSats` are best-effort:
 *  the unvalued-receive and replaced paths omit one or both (addressWatcher §3.4
 *  publishes only what's cheaply in hand, never adding a query). */
export interface WalletEvent {
	walletKind: 'wallet' | 'multisig';
	walletId: number;
	txid?: string;
	event: 'received' | 'confirmed' | 'replaced' | 'large';
	amountSats?: number;
}

/**
 * Subscribe to the live `wallet` topic. `cb` fires once per frame with the parsed
 * payload; malformed frames are ignored. Returns an unsubscribe function (call it
 * on component teardown). SSR-safe: subscribe() no-ops off the browser, so this
 * returns a no-op unsubscribe during SSR.
 */
export function onWalletEvent(cb: (e: WalletEvent) => void): () => void {
	return subscribe('wallet', (ev) => {
		try {
			const data = JSON.parse(ev.data as string) as WalletEvent;
			cb(data);
		} catch {
			// Malformed frame — ignore.
		}
	});
}

/** Default client-side invalidation debounce (§4.2). */
export const WALLET_DEBOUNCE_MS = 800;

/** A debounced function plus a `cancel()` to drop a pending trailing call. */
export type Debounced = (() => void) & { cancel: () => void };

/**
 * Trailing-edge debounce: N calls within `ms` collapse into ONE invocation, fired
 * `ms` after the LAST call. The load-bearing utility behind §4.2 — a block that
 * touches many of a wallet's addresses emits many `wallet` frames in a tight
 * window, and this coalesces them into a single reload instead of one per frame.
 * `cancel()` clears any pending call (call it on teardown so a debounced reload
 * never fires after the component is gone).
 */
export function debounced(fn: () => void, ms: number = WALLET_DEBOUNCE_MS): Debounced {
	let timer: ReturnType<typeof setTimeout> | null = null;
	const wrapped = (() => {
		if (timer !== null) clearTimeout(timer);
		timer = setTimeout(() => {
			timer = null;
			fn();
		}, ms);
	}) as Debounced;
	wrapped.cancel = () => {
		if (timer !== null) {
			clearTimeout(timer);
			timer = null;
		}
	};
	return wrapped;
}
