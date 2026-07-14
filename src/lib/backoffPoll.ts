// Capped-exponential-backoff poller for client-side status polling (cairn-1f0a).
//
// The first-sync pollers (SyncBanner, the /sync page) used to hit /api/sync on a
// fixed setInterval with no backoff. When the backend chain source is
// unreachable the endpoint keeps answering 200 with phase: 'unreachable', so a
// fixed-cadence loop hammered it forever — a continuous request storm on a
// sustained error condition (battery/CPU/network cost on real deployments, and
// the page never reaches network-idle). This wraps a poll task so that:
//
//   • a progressing/healthy result polls at the base cadence,
//   • a sustained error result (or a thrown fetch) backs off exponentially up to
//     a cap, and resets to base the moment things recover,
//   • a terminal result stops polling entirely.
//
// Framework-agnostic and SSR-safe: it only uses setTimeout/clearTimeout and runs
// one poll at a time (recursive timeout, never overlapping), so it is unit-
// testable under fake timers with no DOM. Returns a cancel function.

/**
 * What one poll run reports back, deciding how the next run is scheduled:
 *   • 'reset'   — healthy/progressing: schedule the next run at the base interval
 *                 and reset any accumulated backoff.
 *   • 'backoff' — sustained error/non-progress: schedule the next run after the
 *                 current backoff delay, then grow the delay (capped).
 *   • 'stop'    — terminal (e.g. fully synced): stop polling entirely.
 * A thrown/rejected poll is treated as 'backoff'.
 */
export type PollOutcome = 'reset' | 'backoff' | 'stop';

export interface BackoffPollOptions {
	/** The work to run each tick; its outcome drives the next schedule. */
	poll: () => Promise<PollOutcome>;
	/** Base interval between healthy polls, in ms. */
	baseMs: number;
	/** Upper bound the backoff delay grows to, in ms. */
	maxMs: number;
	/** Run the first poll immediately on start (default true) rather than waiting baseMs. */
	immediate?: boolean;
}

/**
 * Start a backoff poller. Returns a cancel function that stops all further polls
 * (idempotent; safe to call from a component teardown while a poll is in flight).
 */
export function startBackoffPoll(opts: BackoffPollOptions): () => void {
	const { poll, baseMs, maxMs, immediate = true } = opts;
	let delay = baseMs;
	let timer: ReturnType<typeof setTimeout> | null = null;
	let cancelled = false;

	const schedule = (ms: number): void => {
		if (cancelled) return;
		timer = setTimeout(run, ms);
	};

	const run = async (): Promise<void> => {
		if (cancelled) return;
		timer = null;
		let outcome: PollOutcome;
		try {
			outcome = await poll();
		} catch {
			// A thrown poll (e.g. fetch failed) is a sustained-error signal — back off.
			outcome = 'backoff';
		}
		if (cancelled) return;
		if (outcome === 'stop') return;
		if (outcome === 'reset') {
			delay = baseMs;
			schedule(baseMs);
			return;
		}
		// 'backoff': wait the current delay, then grow it toward the cap.
		const thisDelay = delay;
		delay = Math.min(delay * 2, maxMs);
		schedule(thisDelay);
	};

	if (immediate) {
		void run();
	} else {
		schedule(baseMs);
	}

	return () => {
		cancelled = true;
		if (timer !== null) {
			clearTimeout(timer);
			timer = null;
		}
	};
}
