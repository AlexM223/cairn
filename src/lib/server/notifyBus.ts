// In-process event bus for live in-app notification delivery (Unit 2, §2.1 of
// docs/NOTIFICATION-PLAN.md). notify() (notifications.ts) emits on this bus
// after writing the in-app `events` row, and the SSE endpoint
// (src/routes/api/notifications/stream/+server.ts) subscribes to push a live
// unread-count nudge to the connected browser — the same shape the block-tip
// SSE stream (api/events) uses for new blocks, but for notifications.
//
// Deliberately tiny and side-effect-free beyond the emitter itself: it must not
// import db.ts or anything stateful, so both the producer and the consumer can
// depend on it without a cycle. The single event is:
//   'event'  ({ userId: number | null })  — a notification was just recorded.
// A userId of null is an instance-wide/admin-broadcast event: every connected
// user's stream should treat it as a reason to refresh their unread count.

import { EventEmitter } from 'node:events';

/** Payload emitted on the 'event' channel whenever notify() records a row. */
export interface NotifyBusEvent {
	/** The recipient user, or null for an instance-wide/admin-broadcast event. */
	userId: number | null;
}

export const notifyBus = new EventEmitter();

// One stream listener attaches per open tab; a handful of tabs is normal. Lift
// Node's default 10-listener ceiling so that never emits a spurious
// MaxListenersExceeded warning (each stream removes its listener on disconnect,
// so this is a bound, not a leak) — mirrors wireChainEvents' setMaxListeners.
notifyBus.setMaxListeners(256);
