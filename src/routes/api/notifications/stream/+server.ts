// GET /api/notifications/stream — Server-Sent Events push for the in-app bell.
//
// Mirrors src/routes/api/events/+server.ts exactly (ReadableStream + 25s
// heartbeat + cleanup on cancel/abort), but subscribes to the in-process
// notifyBus (notifyBus.ts) instead of the Electrum client. Whenever notify()
// records a row destined for this connected user (or an instance-wide row every
// user sees), we push an `event: notification` frame carrying the current
// unread count, so the browser can update the badge without polling. One
// connection per open tab; listener cleanup on disconnect is mandatory.

import { requireUser } from '$lib/server/api';
import { db } from '$lib/server/db';
import { notifyBus, type NotifyBusEvent } from '$lib/server/notifyBus';
import { childLogger } from '$lib/server/logger';
import type { RequestHandler } from './$types';

const HEARTBEAT_MS = 25_000;
const encoder = new TextEncoder();
const log = childLogger('notify:inapp');

function unreadCount(userId: number): number {
	try {
		const row = db
			.prepare(
				`SELECT COUNT(*) AS n
				   FROM events
				  WHERE (user_id = ? OR user_id IS NULL)
				    AND read_at IS NULL`
			)
			.get(userId) as { n: number };
		return row.n;
	} catch (e) {
		log.error({ err: e, userId }, 'unread count query failed');
		return 0;
	}
}

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
				send(`event: notification\ndata: ${JSON.stringify({ unread: unreadCount(userId) })}\n\n`);
			};

			// Prime the client with the current count immediately on connect.
			sendUnread();

			onEvent = (e) => {
				// An instance-wide event (userId null) is seen by everyone; a scoped
				// event only matters to its own recipient.
				if (e.userId === null || e.userId === userId) sendUnread();
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
