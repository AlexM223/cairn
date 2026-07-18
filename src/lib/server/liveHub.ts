// liveHub — the single owner of the set of live SSE connections and the single
// place that fans frames out to them (docs/LIVE-UPDATES-DESIGN.md §3).
//
// One multiplexed stream (`/api/live`) replaces the per-topic SSE endpoints.
// Every connection registers here once, carrying the identity derived from its
// authenticated session (userId / isAdmin) plus a `send` closure into its
// ReadableStream. Publishers build a payload exactly once and call publish();
// publish() iterates the connection set and filters by scope. It does NOT build
// or transform payloads per-recipient.
//
// HARD INVARIANT: publish() never reads SQLite. Cairn has twice been bitten by
// event-loop stalls from synchronous SQLite reads on a hot path (cairn-xlrm,
// cairn-qyvl); a fan-out that touched the DB once per connection per event would
// be exactly that shape of bug. All data a frame needs must be in hand before
// publish() is called. The one DB read the hub is responsible for — the unread
// count for a `notification` frame — happens ONCE per notifyBus event on the
// notify side (see the bridge below), never inside publish().

import { unreadUserFeedCount } from './activity';
import { notifyBus, type NotifyBusEvent } from './notifyBus';
import { childLogger } from './logger';

const log = childLogger('live');

/** Named SSE topics carried on the multiplexed stream (§2 taxonomy). */
export type LiveTopic =
	| 'block'
	| 'mempool'
	| 'health'
	| 'wallet'
	| 'notification'
	| 'mining'
	| 'mining:pool';

/**
 * Scope decides which connections a published frame reaches — enforced here, at
 * publish time, from session-derived identity (§6). The client can never widen
 * its own scope.
 *  - `{ broadcast: true }` — every entitled connection.
 *  - `{ userId }` — only connections opened by that user.
 *  - `{ admin: true }` — only admin connections (e.g. `mining:pool`).
 */
export type PublishScope = { broadcast: true } | { userId: number } | { admin: true };

/** One live connection. `send` writes a raw SSE frame into its stream. */
export interface LiveConnection {
	userId: number;
	isAdmin: boolean;
	/** Whether this connection opted in to the heavy `mempool` topic (§1.1). */
	wantsMempool: boolean;
	send: (frame: string) => void;
}

const connections = new Set<LiveConnection>();

/** Register a connection; returns an idempotent unregister. */
export function register(conn: LiveConnection): () => void {
	connections.add(conn);
	return () => {
		connections.delete(conn);
	};
}

/** Current live connection count (for tests / diagnostics). */
export function connectionCount(): number {
	return connections.size;
}

/**
 * Fan a fully-built payload out to every connection the scope entitles. The
 * frame is serialized exactly once. A no-op when there are no connections, so
 * publishers never pay for JSON.stringify on an idle process.
 */
export function publish(topic: LiveTopic, scope: PublishScope, data: unknown): void {
	if (connections.size === 0) return;
	const frame = `event: ${topic}\ndata: ${JSON.stringify(data)}\n\n`;
	for (const conn of connections) {
		// Scope filter — the load-bearing security boundary (§6).
		if ('userId' in scope) {
			if (conn.userId !== scope.userId) continue;
		} else if ('admin' in scope) {
			if (!conn.isAdmin) continue;
		}
		// broadcast: no identity filter.

		// `mempool` is suppressible per-connection via ?topics= (§1.1): a client
		// that opted out never receives it even on a broadcast.
		if (topic === 'mempool' && !conn.wantsMempool) continue;

		try {
			conn.send(frame);
		} catch (e) {
			// A dead connection must never break fan-out to the others. Its own
			// stream teardown removes it from the set; we just skip it here.
			log.warn({ err: e, topic }, 'live frame send failed for one connection');
		}
	}
}

// --- notifyBus bridge (§3.2) -------------------------------------------------
//
// notifyBus is untouched; liveHub subscribes to it exactly once at module load
// and republishes matching events as user-scoped `notification` frames. The
// unread count is computed ONCE per event here (one DB read per notify() call,
// NOT per connection), then handed to publish() — keeping the publish() "never
// reads SQLite" invariant intact.

let bridged = false;

function onNotify(e: NotifyBusEvent): void {
	// A null userId is an instance-wide/admin operational event (new signups,
	// node up/down). Those are deliberately excluded from a regular user's feed
	// (unreadUserFeedCount), so they must not bump anyone's badge either —
	// matching the retired notifications/stream endpoint's behavior exactly.
	if (e.userId === null) return;
	const userId = e.userId;
	let unread: number;
	try {
		unread = unreadUserFeedCount(userId); // one DB read per event, notify-side
	} catch (err) {
		log.warn({ err, userId }, 'unread count read failed; skipping notification frame');
		return;
	}
	publish('notification', { userId }, { unread });
}

/** Attach the notifyBus → `notification` bridge exactly once. */
export function ensureNotifyBridge(): void {
	if (bridged) return;
	bridged = true;
	notifyBus.on('event', onNotify);
}

ensureNotifyBridge();
