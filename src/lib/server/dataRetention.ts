// Daily data-retention sweep (cairn-zui7) — the one place unbounded or orphaned
// tables get purged. The 2026-07-06 data audit's top structural finding was that
// nothing in the codebase ever deletes aged rows (balance_snapshots,
// notification_queue, expired sessions, ...); this module is the shared scaffold
// those purge steps register into.
//
// Shape mirrors the other background jobs (addressWatcher.ts et al.): started
// once from hooks.server.ts, idempotent, every timer unref'd so it never holds
// the process open, and strictly best-effort — a step throwing is logged and
// skipped, never rethrown, and never blocks the remaining steps (same
// fault-isolation stance as notificationQueue's drain loop).
//
// Cadence: once shortly after startup (a long-lived instance shouldn't wait a
// day for its first sweep — and short-lived dev instances still get coverage),
// then every 24h.

import { childLogger } from './logger';

const log = childLogger('retention');

/** Run the first sweep this long after boot — after the app has settled. */
const STARTUP_DELAY_MS = 30_000;
const SWEEP_INTERVAL_MS = 24 * 60 * 60_000;

/** One named, independently fault-isolated purge. */
export interface RetentionStep {
	/** Short identifier for logs (e.g. 'balance_snapshots'). */
	name: string;
	/** Do the purge. May be sync or async; a throw/rejection is contained. */
	run: () => void | Promise<void>;
}

// The registered purge steps, run in order. Each retention bead (cairn-zui7.2+)
// contributes one entry here.
const STEPS: RetentionStep[] = [];

/** Outcome of one step in a sweep — surfaced for tests and log summaries. */
export interface StepResult {
	name: string;
	ok: boolean;
}

/**
 * Run every registered step in sequence. A step that throws or rejects is
 * logged and marked failed; the remaining steps still run. Exported (with an
 * injectable step list) so tests can drive the dispatcher directly.
 */
export async function runRetentionSweep(steps: RetentionStep[] = STEPS): Promise<StepResult[]> {
	const results: StepResult[] = [];
	for (const step of steps) {
		try {
			await step.run();
			results.push({ name: step.name, ok: true });
		} catch (e) {
			log.error({ err: e, step: step.name }, 'retention step failed — continuing with the rest');
			results.push({ name: step.name, ok: false });
		}
	}
	if (results.length > 0) {
		log.info(
			{ steps: results.length, failed: results.filter((r) => !r.ok).map((r) => r.name) },
			'retention sweep finished'
		);
	}
	return results;
}

let started = false;

/**
 * Start the daily retention sweep. Idempotent; never throws into the caller
 * (hooks.server.ts wraps it in try/catch too, like the other watchers).
 */
export function startRetentionSweep(): void {
	if (started) return;
	started = true;

	const first = setTimeout(() => {
		void runRetentionSweep().catch((e) => log.error({ err: e }, 'startup retention sweep failed'));
	}, STARTUP_DELAY_MS);
	first.unref?.();

	const daily = setInterval(() => {
		void runRetentionSweep().catch((e) => log.error({ err: e }, 'daily retention sweep failed'));
	}, SWEEP_INTERVAL_MS);
	daily.unref?.();
}
