// GET /api/live — the single multiplexed Server-Sent Events stream
// (docs/LIVE-UPDATES-DESIGN.md §1). One EventSource per browser tab carries
// every named topic the connecting user is entitled to. This replaces the
// per-topic /api/events and /api/notifications/stream endpoints, which remain as
// thin shims during the migration window (retired at the end of Wave 3).
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

import { requireUser } from '$lib/server/api';
import { getChain } from '$lib/server/chain';
import { unreadUserFeedCount } from '$lib/server/activity';
import { register } from '$lib/server/liveHub';
import { childLogger } from '$lib/server/logger';
import type { RequestHandler } from './$types';

const HEARTBEAT_MS = 25_000;
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
	let unregister: (() => void) | null = null;

	// Idempotent teardown: runs on client disconnect (cancel/abort), enqueue
	// failure, or chain reconfiguration. Never leaks the hub registration or the
	// heartbeat timer, and is safe to call more than once.
	const cleanup = () => {
		if (closed) return;
		closed = true;
		if (heartbeat !== null) {
			clearInterval(heartbeat);
			heartbeat = null;
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

			// Prime the tip (§1.2 — no replay buffers; every connect primes current
			// state). headersSubscribe() returns the current tip AND sets the
			// client's headersSubscribed flag, so the process-level chainEvents
			// listener starts receiving pushes for this process even if no
			// /api/events connection is open.
			try {
				const tip = await electrum.headersSubscribe();
				send(`event: block\ndata: ${JSON.stringify({ height: tip.height })}\n\n`);
			} catch (e) {
				const message = e instanceof Error ? e.message : String(e);
				log.warn({ err: e }, 'live tip prime failed');
				send(`event: error\ndata: ${JSON.stringify({ message })}\n\n`);
				endStream();
				return;
			}

			// Prime the current unread count for the session user. This is a
			// connect-time-only DB read (once per connection), NOT on the publish
			// hot path — the hub's "publish() never reads SQLite" invariant is
			// about fan-out, not the one-shot prime.
			try {
				send(
					`event: notification\ndata: ${JSON.stringify({ unread: unreadUserFeedCount(userId) })}\n\n`
				);
			} catch (e) {
				log.warn({ err: e, userId }, 'live unread prime failed');
			}

			// Register with the hub — from here on, block/notification (and, in
			// later waves, wallet/mempool/health/mining) frames fan out via
			// liveHub.publish().
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
