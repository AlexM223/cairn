// liveClient — the ONE place in the client codebase allowed to construct an
// EventSource (docs/LIVE-UPDATES-DESIGN.md §4.1). A singleton over a single
// connection to /api/live, multiplexing every named topic. Components never hold
// an EventSource themselves — they read per-topic rune stores (tipHeight.svelte,
// …) that this module feeds, which makes it structurally impossible to open a
// second connection.
//
// subscribe(topic, handler) refcounts handlers across all topics: the EventSource
// opens on the first subscriber and closes when the last one unsubscribes. Named
// SSE events are dispatched to the topic's handler set.
//
// Reconnect/visibility/stale hardening is the same pattern proven in
// sseReconnect.ts and liveBlocks.ts — reconnect when the tab is foregrounded if
// the connection is dead or has gone quiet (mobile app-switch kills SSE while
// backgrounded and native retry is unreliable), and a watchdog that proactively
// reconnects after a silent period. SSR-safe: every entry point no-ops when
// there's no window/EventSource, so importing this on the server is harmless.

const STALE_MS = 90_000;
const STALE_CHECK_INTERVAL_MS = 30_000;
const VISIBILITY_STALE_MS = 30_000;

// Every named topic the stream can carry (§2 taxonomy). Listeners for all of
// them are attached up front on each (re)connect so dispatch works regardless of
// the order pages subscribe in — a subscribe() after connect never misses frames.
const KNOWN_TOPICS = [
	'block',
	'mempool',
	'health',
	'wallet',
	'notification',
	'mining',
	'mining:pool'
] as const;

type LiveHandler = (ev: MessageEvent) => void;

const handlers = new Map<string, Set<LiveHandler>>();
let source: EventSource | null = null;
let lastEventAt = 0;
let staleTimer: ReturnType<typeof setInterval> | null = null;
let visibilityBound = false;

function isBrowser(): boolean {
	return typeof window !== 'undefined' && typeof EventSource !== 'undefined';
}

function dispatch(topic: string, ev: MessageEvent): void {
	lastEventAt = Date.now();
	const set = handlers.get(topic);
	if (!set) return;
	for (const h of set) {
		try {
			h(ev);
		} catch {
			// A throwing consumer must never break delivery to the others.
		}
	}
}

function attach(src: EventSource): void {
	src.addEventListener('open', () => {
		lastEventAt = Date.now();
	});
	for (const topic of KNOWN_TOPICS) {
		src.addEventListener(topic, (ev) => dispatch(topic, ev as MessageEvent));
	}
}

function onVisibilityChange(): void {
	if (document.hidden) return;
	const stale = Date.now() - lastEventAt > VISIBILITY_STALE_MS;
	if (!source || source.readyState === EventSource.CLOSED || stale) reconnect();
}

function staleCheck(): void {
	if (
		source &&
		Date.now() - lastEventAt > STALE_MS &&
		source.readyState !== EventSource.CONNECTING
	) {
		reconnect();
	}
}

function openSource(): void {
	lastEventAt = Date.now();
	source = new EventSource('/api/live');
	attach(source);
}

function reconnect(): void {
	if (source) {
		try {
			source.close();
		} catch {
			// ignore
		}
	}
	openSource();
}

function ensureConnected(): void {
	if (!isBrowser()) return;
	if (!source) openSource();
	if (!visibilityBound) {
		document.addEventListener('visibilitychange', onVisibilityChange);
		visibilityBound = true;
	}
	if (staleTimer === null) {
		staleTimer = setInterval(staleCheck, STALE_CHECK_INTERVAL_MS);
	}
}

function teardownIfIdle(): void {
	for (const set of handlers.values()) {
		if (set.size > 0) return;
	}
	// No subscribers left anywhere — tear the connection and timers down.
	if (source) {
		try {
			source.close();
		} catch {
			// ignore
		}
		source = null;
	}
	if (staleTimer !== null) {
		clearInterval(staleTimer);
		staleTimer = null;
	}
	if (visibilityBound) {
		document.removeEventListener('visibilitychange', onVisibilityChange);
		visibilityBound = false;
	}
}

/**
 * Subscribe to a named live topic. Returns an unsubscribe function. The
 * underlying EventSource is shared across every subscriber and every topic; it
 * opens on the first subscription and closes when the last one is removed.
 * SSR-safe: a no-op returning a no-op unsubscribe when there's no EventSource.
 */
export function subscribe(topic: string, handler: LiveHandler): () => void {
	if (!isBrowser()) return () => {};
	let set = handlers.get(topic);
	if (!set) {
		set = new Set();
		handlers.set(topic, set);
	}
	set.add(handler);
	ensureConnected();

	return () => {
		const s = handlers.get(topic);
		if (s) {
			s.delete(handler);
			if (s.size === 0) handlers.delete(topic);
		}
		teardownIfIdle();
	};
}
