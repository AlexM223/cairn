// Client-side subscription to new-block notifications, throttled.
//
// Transport is now the single multiplexed /api/live stream (liveClient) rather
// than a dedicated /api/events EventSource — see docs/LIVE-UPDATES-DESIGN.md.
// liveClient owns the one connection plus all reconnect/visibility/stale
// hardening; onNewBlock keeps ONLY the block-height throttle/dedupe that its
// consumers depend on, layered on top of a plain `block` subscription. The
// public API (onNewBlock(callback) → unsubscribe) is unchanged, so every
// existing consumer page keeps working without edits.

import { subscribe } from './live/liveClient';

const THROTTLE_MS = 3_000;

/**
 * Subscribe to new-block events. The callback is throttled: events arriving
 * within 3s of the last delivered one are dropped, except that a strictly
 * higher height is always delivered once the throttle window elapses.
 *
 * SSR-safe (no-op on the server via liveClient).
 * Returns an unsubscribe function that removes the subscription and tears down
 * any pending throttle timer.
 */
export function onNewBlock(callback: (height: number) => void): () => void {
	if (typeof window === 'undefined' || typeof EventSource === 'undefined') {
		return () => {};
	}

	let lastDeliveredAt = 0;
	let lastDeliveredHeight: number | null = null;
	let pendingHeight: number | null = null;
	let pendingTimer: ReturnType<typeof setTimeout> | null = null;

	const deliver = (height: number) => {
		lastDeliveredAt = Date.now();
		lastDeliveredHeight = height;
		callback(height);
	};

	const unsubscribe = subscribe('block', (e: MessageEvent) => {
		let height: number;
		try {
			height = Number((JSON.parse(e.data as string) as { height: unknown }).height);
		} catch {
			return;
		}
		if (!Number.isFinite(height)) return;

		const elapsed = Date.now() - lastDeliveredAt;
		if (elapsed >= THROTTLE_MS) {
			deliver(height);
			return;
		}
		// Inside the throttle window: keep only a strictly higher height and
		// deliver it once the window closes.
		if (lastDeliveredHeight !== null && height <= lastDeliveredHeight) return;
		pendingHeight = pendingHeight !== null ? Math.max(pendingHeight, height) : height;
		if (pendingTimer === null) {
			pendingTimer = setTimeout(() => {
				pendingTimer = null;
				const h = pendingHeight;
				pendingHeight = null;
				if (h !== null && (lastDeliveredHeight === null || h > lastDeliveredHeight)) {
					deliver(h);
				}
			}, THROTTLE_MS - elapsed);
		}
	});

	return () => {
		if (pendingTimer !== null) {
			clearTimeout(pendingTimer);
			pendingTimer = null;
		}
		pendingHeight = null;
		unsubscribe();
	};
}
