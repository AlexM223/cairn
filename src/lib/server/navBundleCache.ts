// TTL cache for the (app) layout's per-navigation nav-chrome bundle
// (unbacked-wallet nudge / backup reminder / active announcements).
//
// src/routes/(app)/+layout.server.ts runs on every navigation and every full
// document load, and all three of these reads are real node:sqlite queries
// (joins/subselects), not the cheap single-keyed SELECTs cairn-xlrm already
// trimmed from this same load. node:sqlite's DatabaseSync API is synchronous,
// and Node is single-threaded, so each of these calls blocks the event loop —
// on a full document load that delays TTFB (the header/avatar button looks
// unresponsive only because JS hasn't hydrated yet), and on client-side nav it
// serializes a fresh navigation behind whatever abandoned one is still running
// on the event loop (cairn-t72a, follow-up to cairn-xlrm).
//
// Serving a stale bundle for up to TTL_MS is safe because every consumer of
// this data already hides itself OPTIMISTICALLY on the client the instant the
// user dismisses it (sessionStorage / component $state in
// (app)/+layout.svelte for the two backup banners, and the equivalent
// optimistic-hide in AnnouncementBanner.svelte) — so within a session, staleness
// in this server-side cache is never actually visible. A new banner becoming
// eligible, or an admin publishing a new announcement, can take up to TTL_MS to
// appear; that's an acceptable trade for skipping three synchronous SQLite
// queries on every nav.

import type { UnbackedWallet } from './backups';
import type { Announcement } from './announcements';

export interface NavBundle {
	unbackedWallets: UnbackedWallet[];
	showBackupReminder: boolean;
	announcements: Announcement[];
}

const TTL_MS = 15_000;

interface Entry {
	value: NavBundle;
	at: number;
}

const cache = new Map<number, Entry>();

/**
 * Return the cached nav bundle for `userId` if still fresh, else call `load`,
 * cache its result, and return it. `load` is synchronous — it's a bundle of
 * node:sqlite reads, not I/O — so this stays synchronous too rather than
 * wrapping everything in an unnecessary Promise.
 */
export function cachedNavBundle(userId: number, load: () => NavBundle): NavBundle {
	const now = Date.now();
	const entry = cache.get(userId);
	if (entry && now - entry.at < TTL_MS) return entry.value;
	const value = load();
	cache.set(userId, { value, at: now });
	return value;
}

/** Clear every cached entry. Test-only, for isolation between cases. */
export function resetNavBundleCacheForTests(): void {
	cache.clear();
}
