// GET /api/live — the single multiplexed Server-Sent Events stream
// (docs/LIVE-UPDATES-DESIGN.md §1). One EventSource per browser tab carries
// every named topic the connecting user is entitled to. This replaced — and, as
// of Wave 3, fully retired — the per-topic /api/events (block tips) and
// /api/notifications/stream (unread badge) endpoints.
//
// Connection lifecycle reuses the battle-tested skeleton from /api/events:
// ReadableStream + 25s heartbeat + idempotent cleanup on cancel/abort.
//
// Fan-out itself lives in liveHub, not here: block frames come from a single
// process-level electrum 'header' listener in chainEvents.ts, and notification
// frames from the notifyBus bridge in liveHub.ts. A connection does NOT attach
// its own 'header' listener (that redundant-listener-per-tab cost is exactly
// what this design removes, §3.3). It only calls headersSubscribe() once on
// connect — which primes its current tip AND arms the process-level pushes the
// chainEvents listener consumes — then registers with the hub.
//
// ELECTRUM-DOWN RESILIENCE (cairn-yc87): tip-prime MUST NOT be able to end the
// stream. Since Wave 3 removed all polling, this stream is the ONLY update path;
// on an Umbrel box whose sole backend is an unreachable public Electrum fallback
// (dependencies:[] in the store), headersSubscribe() rejects. If that closed the
// stream the browser's EventSource would reconnect-loop forever, every reconnect
// re-priming and re-failing — an app that SSR-renders but never updates and
// hammers the server, which is exactly the "app is failing" report. Instead we
// keep the connection open, nudge the client to show the degraded transport
// state (a `health` frame — chainHealth.svelte re-reads the authoritative
// /api/chain-health union verdict; no new client protocol), and retry the
// subscribe in the background with backoff so block frames start flowing the
// moment Electrum recovers. Every Electrum-independent topic (notification, and
// the hub-fanned health/mempool/wallet/mining frames) flows regardless.

import { requireUser } from '$lib/server/api';
import { getChain } from '$lib/server/chain';
import { unreadUserFeedCount } from '$lib/server/activity';
import { register } from '$lib/server/liveHub';
import { childLogger } from '$lib/server/logger';
import type { RequestHandler } from './$types';

const HEARTBEAT_MS = 25_000;
// Background tip-prime retry backoff while Electrum is unreachable. Bounded and
// exponential so a persistent outage doesn't hammer the dead backend: the
// Electrum client's own ensureConnected() fail-fast (a scheduled reconnect
// rejects fresh dials, cairn-sp74) already absorbs concurrent retries cheaply,
// and each connection spaces its own attempts out to a 60s ceiling.
const TIP_RETRY_MIN_MS = 5_000;
const TIP_RETRY_MAX_MS = 60_000;
const encoder = new TextEncoder();
const log = childLogger('live');

export const GET: RequestHandler = async (event) => {
	const user = requireUser(event);
	const userId = user.id;
	const isAdmin = user.isAdmin;

	// ?topics= is an optional SUPPRESSION hint, never an authorization mechanism
	// (§1.1). Default (no param) = receive everything the user is entitled to,
	// including the heavy `mempool` topic; a client opts OUT of mempool by
	// passing a ?topics= list that omits it.
	const topicsParam = event.url.searchParams.get('topics');
	const wantsMempool =
		topicsParam === null ||
		topicsParam
			.split(',')
			.map((s) => s.trim())
			.includes('mempool');

	// Pin the client this stream starts with. reconfigureChain() can swap the
	// shared instance at runtime; the heartbeat detects that and ends the stream
	// so the browser's EventSource reconnects to a handler on the fresh client
	// (and re-primes + re-arms header pushes there) — same strategy as /api/events.
	const electrum = getChain().electrum;

	let closed = false;
	let heartbeat: ReturnType<typeof setInterval> | null = null;
	let retryTimer: ReturnType<typeof setTimeout> | null = null;
	let unregister: (() => void) | null = null;

	// Idempotent teardown: runs on client disconnect (cancel/abort), enqueue
	// failure, or chain reconfiguration. Never leaks the hub registration, the
	// heartbeat timer, or a pending tip-prime retry, and is safe to call more
	// than once.
	const cleanup = () => {
		if (closed) return;
		closed = true;
		if (heartbeat !== null) {
			clearInterval(heartbeat);
			heartbeat = null;
		}
		if (retryTimer !== null) {
			clearTimeout(retryTimer);
			retryTimer = null;
		}
		if (unregister !== null) {
			unregister();
			unregister = null;
		}
	};

	const stream = new ReadableStream<Uint8Array>({
		async start(controller) {
			const send = (text: string) => {
				if (closed) return;
				try {
					controller.enqueue(encoder.encode(text));
				} catch {
					// Stream already closed under us; stop everything.
					cleanup();
				}
			};
			const endStream = () => {
				cleanup();
				try {
					controller.close();
				} catch {
					// Already closed.
				}
			};

			// Nudge the client's transport-health store (chainHealth.svelte) to
			// re-read /api/chain-health's authoritative union verdict. Sent when a
			// tip-prime fails (banner shows degraded) and again when a background
			// retry recovers (banner clears) — reusing the existing `health` frame,
			// which the client already treats as a nudge, so there is no new
			// client-side protocol. Payload mirrors chainEvents.publishHealth's shape
			// but the client ignores its content; only the frame's arrival matters.
			const sendHealthNudge = (electrumState: 'up' | 'down') => {
				send(
					`event: health\ndata: ${JSON.stringify({ electrum: electrumState, tipHeight: 0, tipAgeMs: null })}\n\n`
				);
			};

			// Try to prime the tip. On success, send the current tip as a `block`
			// frame; headersSubscribe() also arms the process-level header pushes the
			// chainEvents listener consumes. Returns whether it succeeded. NEVER ends
			// the stream on failure (that is the whole point of cairn-yc87).
			const primeTip = async (): Promise<boolean> => {
				try {
					const tip = await electrum.headersSubscribe();
					send(`event: block\ndata: ${JSON.stringify({ height: tip.height })}\n\n`);
					return true;
				} catch (e) {
					log.warn({ err: e }, 'live tip prime failed; stream stays open, will retry');
					return false;
				}
			};

			// Background retry of the tip prime while Electrum is unreachable. Grows
			// the delay exponentially to the ceiling, contained so it can never throw
			// out of the timer, and stops the instant the stream closes or a prime
			// succeeds. On success it re-nudges health so a per-connection recovery is
			// deterministic even if the process-level 'connect' event didn't re-fire.
			let retryDelay = TIP_RETRY_MIN_MS;
			const scheduleTipRetry = () => {
				if (closed || retryTimer !== null) return;
				retryTimer = setTimeout(async () => {
					retryTimer = null;
					if (closed) return;
					if (await primeTip()) {
						sendHealthNudge('up');
						return; // recovered — ongoing updates now arrive via the hub
					}
					retryDelay = Math.min(retryDelay * 2, TIP_RETRY_MAX_MS);
					scheduleTipRetry();
				}, retryDelay);
				retryTimer.unref?.();
			};

			// Prime the tip (§1.2 — no replay buffers; every connect primes current
			// state). If it fails, keep the connection open, tell the client the
			// transport is degraded, and retry in the background.
			if (!(await primeTip())) {
				sendHealthNudge('down');
				scheduleTipRetry();
			}

			// Prime the current unread count for the session user. This is a
			// connect-time-only DB read (once per connection), NOT on the publish
			// hot path — the hub's "publish() never reads SQLite" invariant is
			// about fan-out, not the one-shot prime. Independent of Electrum, so it
			// flows even when the tip prime above failed.
			try {
				send(
					`event: notification\ndata: ${JSON.stringify({ unread: unreadUserFeedCount(userId) })}\n\n`
				);
			} catch (e) {
				log.warn({ err: e, userId }, 'live unread prime failed');
			}

			// Register with the hub — from here on, block/notification (and, in
			// later waves, wallet/mempool/health/mining) frames fan out via
			// liveHub.publish(). Done regardless of the tip-prime outcome so that
			// once Electrum recovers, the process-level chainEvents 'connect'/'header'
			// listeners fan out to this connection too.
			unregister = register({ userId, isAdmin, wantsMempool, send });

			// Keep proxies (including Tor) from idling the connection out. Also our
			// chance to notice that reconfigureChain() replaced the client we pinned.
			heartbeat = setInterval(() => {
				// getChain() lazily rebuilds the ChainService when reconfigureChain()
				// nulled the singleton, and construction can throw — synchronously,
				// inside this raw setInterval callback with no caller to catch it. An
				// uncaught throw would escape to the process-level crash guard and take
				// every connected user's stream down. Contain it to this one connection
				// (cairn-ldvt): end this stream and let the browser reconnect.
				try {
					if (getChain().electrum !== electrum) {
						endStream();
						return;
					}
					send(`: ping\n\n`);
				} catch (e) {
					log.warn({ err: e }, 'live heartbeat failed');
					endStream();
				}
			}, HEARTBEAT_MS);
			heartbeat.unref?.();
		},
		cancel() {
			cleanup();
		}
	});

	// Belt and braces: some platforms surface disconnects via the abort signal
	// rather than (or before) ReadableStream cancel.
	event.request.signal.addEventListener('abort', cleanup, { once: true });

	return new Response(stream, {
		headers: {
			'Content-Type': 'text/event-stream',
			'Cache-Control': 'no-cache',
			Connection: 'keep-alive',
			'X-Accel-Buffering': 'no'
		}
	});
};
