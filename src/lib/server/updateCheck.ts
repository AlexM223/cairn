// Update-availability check (cairn-ivae.2): compare the running version
// against the latest GitHub release tag and surface a "you're behind" notice
// on the admin dashboard. Notice only — the actual update is always an
// external image pull (Umbrel/Start9 own that lifecycle), so there is no
// auto-update machinery here and never will be.
//
// Shape: a cached, self-refreshing lookup rather than a boot-time cron. The
// admin dashboard load calls getUpdateNotice(), which answers INSTANTLY from
// the in-process cache and — when the cache is older than a day — kicks off a
// background refresh for a later request. GitHub being slow or unreachable can
// therefore never block or slow the dashboard: the fetch is never awaited on
// the request path, times out after a few seconds, and fails silent (log
// only), per the acceptance criteria — no nagging on a network blip.

import { childLogger } from './logger';
import pkg from '../../../package.json';

const log = childLogger('update-check');

/** Confirmed public repo (docs/PUBLISH-PLAN.md). */
const REPO = 'AlexM223/cairn';
const LATEST_RELEASE_API = `https://api.github.com/repos/${REPO}/releases/latest`;

/** Daily, matching Gitea's update-checker cron cadence. */
const CHECK_INTERVAL_MS = 24 * 3_600_000;
const FETCH_TIMEOUT_MS = 5_000;

export const CURRENT_VERSION: string = pkg.version;

export interface UpdateNotice {
	currentVersion: string;
	latestVersion: string;
	/** Release-notes page for the latest release. */
	releaseUrl: string;
}

interface CacheEntry {
	checkedAt: number;
	latestTag: string | null; // null = last check failed → no notice
	releaseUrl: string | null;
}

let cache: CacheEntry | null = null;
let inflight = false;

/**
 * True when `latest` is a strictly newer semver-ish version than `current`.
 * Tolerates a leading 'v' and ignores any pre-release suffix. Unparseable
 * input compares as "not newer" — fail toward silence, never a bogus nag.
 */
export function isNewerVersion(latest: string, current: string): boolean {
	const parse = (v: string): number[] | null => {
		const m = v.trim().replace(/^v/i, '').match(/^(\d+)\.(\d+)\.(\d+)/);
		return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
	};
	const a = parse(latest);
	const b = parse(current);
	if (!a || !b) return false;
	for (let i = 0; i < 3; i++) {
		if (a[i] !== b[i]) return a[i] > b[i];
	}
	return false;
}

/**
 * Fetch the latest release tag from GitHub and store it in the cache. A
 * failure of any kind (network, 4xx/5xx, bad JSON) caches a null result — the
 * dashboard shows nothing and we simply try again after the next interval.
 * `fetchFn` is injectable for tests. Exported for tests; production code goes
 * through getUpdateNotice().
 */
export async function refreshLatestRelease(fetchFn: typeof fetch = fetch): Promise<void> {
	try {
		const res = await fetchFn(LATEST_RELEASE_API, {
			headers: { accept: 'application/vnd.github+json', 'user-agent': `cairn/${CURRENT_VERSION}` },
			signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
		});
		if (!res.ok) throw new Error(`GitHub responded ${res.status}`);
		const body = (await res.json()) as { tag_name?: unknown; html_url?: unknown };
		const tag = typeof body.tag_name === 'string' ? body.tag_name : null;
		cache = {
			checkedAt: Date.now(),
			latestTag: tag,
			releaseUrl: typeof body.html_url === 'string' ? body.html_url : null
		};
		log.info({ latest: tag, current: CURRENT_VERSION }, 'update check completed');
	} catch (e) {
		// Fail silent: a null cache entry means "no notice" until the next pass.
		cache = { checkedAt: Date.now(), latestTag: null, releaseUrl: null };
		log.warn({ err: e }, 'update check failed (will retry after the next interval)');
	}
}

/**
 * The notice for the admin dashboard, or null when up to date / never checked
 * / the last check failed. Always instant: answers from the cache and, when
 * the cache is stale, schedules a background refresh WITHOUT awaiting it.
 */
export function getUpdateNotice(): UpdateNotice | null {
	if (!cache || Date.now() - cache.checkedAt > CHECK_INTERVAL_MS) {
		if (!inflight) {
			inflight = true;
			void refreshLatestRelease().finally(() => {
				inflight = false;
			});
		}
	}
	if (!cache?.latestTag) return null;
	if (!isNewerVersion(cache.latestTag, CURRENT_VERSION)) return null;
	return {
		currentVersion: CURRENT_VERSION,
		latestVersion: cache.latestTag.replace(/^v/i, ''),
		releaseUrl: cache.releaseUrl ?? `https://github.com/${REPO}/releases`
	};
}

/** Test hook: reset the module cache between cases. */
export function resetUpdateCheckCache(): void {
	cache = null;
	inflight = false;
}
