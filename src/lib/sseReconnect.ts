// Shared connection-lifecycle wrapper for client-side SSE subscriptions that
// need to survive mobile app-switching: the underlying EventSource often
// fails to auto-reconnect after the OS kills the connection while the app is
// backgrounded, and the browser's native retry doesn't reliably fire once the
// tab is foregrounded again.
//
// Factored out of liveBlocks.ts's onNewBlock (which keeps its own copy of
// this pattern inline, interleaved with block-height throttling logic that
// doesn't generalize). This version is for consumers — like
// NotificationPanel — that just need a resilient single-event subscription
// with no extra delivery semantics.
//
// Behaviour mirrors liveBlocks.ts:
//  - reconnects when the page becomes visible again if the connection is
//    closed or has been silent for a while, and
//  - proactively reconnects if no event has been seen for a while regardless
//    of visibility.
//
// SSR-safe (no-op on the server). Returns an unsubscribe function that closes
// the connection and tears down all listeners/timers.

const STALE_MS = 90_000;
const STALE_CHECK_INTERVAL_MS = 30_000;
const VISIBILITY_STALE_MS = 30_000;

export interface ResilientEventSourceOptions {
	/** Named SSE event to subscribe to (e.g. 'notification', 'block'). */
	eventName: string;
	/** Called for every received event of `eventName`. */
	onMessage: (ev: MessageEvent) => void;
	/** Called whenever a connection (re)opens, including reconnects. */
	onOpen?: () => void;
}

export function createResilientEventSource(
	url: string,
	options: ResilientEventSourceOptions
): () => void {
	if (typeof window === 'undefined' || typeof EventSource === 'undefined') {
		return () => {};
	}

	let source: EventSource;
	let lastEventAt = Date.now();

	function attachListeners(src: EventSource) {
		src.addEventListener('open', () => {
			lastEventAt = Date.now();
			options.onOpen?.();
		});
		src.addEventListener(options.eventName, (ev: MessageEvent) => {
			lastEventAt = Date.now();
			options.onMessage(ev);
		});
	}

	function reconnect() {
		try {
			source.close();
		} catch {
			// ignore
		}
		lastEventAt = Date.now();
		source = new EventSource(url);
		attachListeners(source);
	}

	// Initial connection.
	source = new EventSource(url);
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
		source.close();
	};
}
