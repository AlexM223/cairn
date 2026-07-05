// GET /api/events — Server-Sent Events stream of new-block notifications.
// One connection per open tab; listener cleanup on disconnect is mandatory.

import { requireUser } from '$lib/server/api';
import { getChain } from '$lib/server/chain';
import { childLogger } from '$lib/server/logger';
import type { ElectrumHeader } from '$lib/server/electrum/client';
import type { RequestHandler } from './$types';

const HEARTBEAT_MS = 25_000;
const encoder = new TextEncoder();
const log = childLogger('events');

export const GET: RequestHandler = async (event) => {
	requireUser(event);

	// Pin the client this stream starts with. reconfigureChain() can swap the
	// shared instance at runtime; if that happens we end this stream and let
	// the browser's EventSource reconnect to a handler using the fresh client.
	const electrum = getChain().electrum;

	let closed = false;
	let heartbeat: ReturnType<typeof setInterval> | null = null;
	let onHeader: ((header: ElectrumHeader) => void) | null = null;

	// Idempotent: runs on client disconnect (cancel/abort), enqueue failure,
	// or chain reconfiguration. Never leaks the 'header' listener or the timer.
	const cleanup = () => {
		if (closed) return;
		closed = true;
		if (heartbeat !== null) {
			clearInterval(heartbeat);
			heartbeat = null;
		}
		if (onHeader !== null) {
			electrum.off('header', onHeader);
			onHeader = null;
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
			const sendBlock = (height: number) => {
				send(`event: block\ndata: ${JSON.stringify({ height })}\n\n`);
			};

			let lastHeight: number | null = null;

			// Subscribe (also returns the current tip so clients sync immediately).
			try {
				const tip = await electrum.headersSubscribe();
				lastHeight = tip.height;
				sendBlock(tip.height);
			} catch (e) {
				const message = e instanceof Error ? e.message : String(e);
				log.warn({ err: e }, 'sse header subscription failed');
				send(`event: error\ndata: ${JSON.stringify({ message })}\n\n`);
				endStream();
				return;
			}

			onHeader = (header) => {
				// Dedupe: reconnect resubscription re-emits the current tip.
				if (header.height === lastHeight) return;
				lastHeight = header.height;
				sendBlock(header.height);
			};
			electrum.on('header', onHeader);

			// Keep proxies from idling the connection out. Also our chance to
			// notice that reconfigureChain() replaced the client we're pinned to.
			heartbeat = setInterval(() => {
				if (getChain().electrum !== electrum) {
					endStream();
					return;
				}
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
