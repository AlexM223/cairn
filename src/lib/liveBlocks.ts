// Client-side subscription to /api/events (SSE) for new-block notifications.

const THROTTLE_MS = 3_000;
const STALE_MS = 90_000;
const STALE_CHECK_INTERVAL_MS = 30_000;
const VISIBILITY_STALE_MS = 30_000;

/**
 * Subscribe to new-block events. The callback is throttled: events arriving
 * within 3s of the last delivered one are dropped, except that a strictly
 * higher height is always delivered once the throttle window elapses.
 *
 * Resilient to mobile app-switching: the underlying EventSource often fails
 * to auto-reconnect after the OS kills the connection while the app is
 * backgrounded. To cover that, this also:
 *  - reconnects when the page becomes visible again if the connection is
 *    closed or has been silent for a while, and
 *  - proactively reconnects if no event has been seen for 90s.
 *
 * SSR-safe (no-op on the server).
 * Returns an unsubscribe function that closes the connection and tears down
 * all listeners/timers.
 */
export function onNewBlock(callback: (height: number) => void): () => void {
	if (typeof window === 'undefined' || typeof EventSource === 'undefined') {
		return () => {};
	}

	let source: EventSource;
	let lastEventAt = Date.now();

	let lastDeliveredAt = 0;
	let lastDeliveredHeight: number | null = null;
	let pendingHeight: number | null = null;
	let pendingTimer: ReturnType<typeof setTimeout> | null = null;

	const deliver = (height: number) => {
		lastDeliveredAt = Date.now();
		lastDeliveredHeight = height;
		callback(height);
	};

	function attachListeners(src: EventSource) {
		src.addEventListener('open', () => {
			lastEventAt = Date.now();
		});

		src.addEventListener('block', (e: MessageEvent) => {
			lastEventAt = Date.now();

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
	}

	function reconnect() {
		if (pendingTimer !== null) {
			clearTimeout(pendingTimer);
			pendingTimer = null;
		}
		pendingHeight = null;
		try {
			source.close();
		} catch {
			// ignore
		}
		lastEventAt = Date.now();
		source = new EventSource('/api/events');
		attachListeners(source);
	}

	// Initial connection.
	source = new EventSource('/api/events');
	attachListeners(source);

	// Force a reconnect when the page returns to the foreground if the
	// connection is dead or has gone quiet for a while (mobile app-switch).
	const onVisibilityChange = () => {
		if (document.hidden) return;
		const stale = Date.now() - lastEventAt > VISIBILITY_STALE_MS;
		if (source.readyState === EventSource.CLOSED || stale) {
			reconnect();
		}
	};
	document.addEventListener('visibilitychange', onVisibilityChange);

	// Proactively reconnect if we haven't seen any event (including
	// EventSource's own heartbeat) in a while. Skip while a connection
	// attempt is already in flight.
	const staleTimer = setInterval(() => {
		if (Date.now() - lastEventAt > STALE_MS && source.readyState !== EventSource.CONNECTING) {
			reconnect();
		}
	}, STALE_CHECK_INTERVAL_MS);

	return () => {
		document.removeEventListener('visibilitychange', onVisibilityChange);
		clearInterval(staleTimer);
		if (pendingTimer !== null) {
			clearTimeout(pendingTimer);
			pendingTimer = null;
		}
		source.close();
	};
}
