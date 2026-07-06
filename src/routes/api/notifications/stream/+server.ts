// GET /api/notifications/stream — Server-Sent Events push for the in-app bell.
//
// Mirrors src/routes/api/events/+server.ts exactly (ReadableStream + 25s
// heartbeat + cleanup on cancel/abort), but subscribes to the in-process
// notifyBus (notifyBus.ts) instead of the Electrum client. Whenever notify()
// records one of THIS user's own feed-relevant rows, we push an
// `event: notification` frame carrying the current unread count, so the browser
// can update the badge without polling. The count and the trigger both use the
// simplified user-feed scoping (see unreadUserFeedCount) — instance-wide and
// operational events must never bump a regular user's badge, matching what the
// bell actually shows (GET /api/notifications). One connection per open tab;
// listener cleanup on disconnect is mandatory.

import { requireUser } from '$lib/server/api';
import { unreadUserFeedCount } from '$lib/server/activity';
import { notifyBus, type NotifyBusEvent } from '$lib/server/notifyBus';
import type { RequestHandler } from './$types';

const HEARTBEAT_MS = 25_000;
const encoder = new TextEncoder();

export const GET: RequestHandler = async (event) => {
	const user = requireUser(event);
	const userId = user.id;

	let closed = false;
	let heartbeat: ReturnType<typeof setInterval> | null = null;
	let onEvent: ((e: NotifyBusEvent) => void) | null = null;

	// Idempotent teardown: runs on client disconnect (cancel/abort) or enqueue
	// failure. Never leaks the bus listener or the heartbeat timer.
	const cleanup = () => {
		if (closed) return;
		closed = true;
		if (heartbeat !== null) {
			clearInterval(heartbeat);
			heartbeat = null;
		}
		if (onEvent !== null) {
			notifyBus.off('event', onEvent);
			onEvent = null;
		}
	};

	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			const send = (text: string) => {
				if (closed) return;
				try {
					controller.enqueue(encoder.encode(text));
				} catch {
					cleanup();
				}
			};
			const sendUnread = () => {
				send(
					`event: notification\ndata: ${JSON.stringify({ unread: unreadUserFeedCount(userId) })}\n\n`
				);
			};

			// Prime the client with the current count immediately on connect.
			sendUnread();

			onEvent = (e) => {
				// Only THIS user's own rows bump their badge. Instance-wide events
				// (userId null — new signups, invites, node up/down) are operational
				// and deliberately excluded from the user feed, so they must not
				// trigger a badge refresh either (they'd leak the event's timing and
				// disagree with what the bell actually lists).
				if (e.userId === userId) sendUnread();
			};
			notifyBus.on('event', onEvent);

			// Keep proxies from idling the connection out.
			heartbeat = setInterval(() => {
				send(`: ping\n\n`);
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
