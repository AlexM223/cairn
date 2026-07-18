// liveTickers — the process-level polling that has no discrete "changed" event
// to hook, driven off ONE shared timer (docs/LIVE-UPDATES-DESIGN.md §3.4).
//
// Today that's just the mempool ticker. A block arriving fires an Electrum
// 'header' event (chainEvents.ts), and a notify() call fires notifyBus — both
// are real signals we publish off directly. The mempool, by contrast, churns
// continuously with no per-change event, so a single 5-second timer samples the
// already-SWR-cached snapshot, diffs it against the last emitted frame, and
// publishes a broadcast `mempool` frame only when something actually changed.
//
// Two properties keep this cheap at every scale:
//   - the timer is `unref()`'d and does nothing while no connection wants the
//     `mempool` topic (mempoolSubscriberCount() === 0) — an idle instance never
//     reads the chain for a ticker nobody is watching;
//   - it reads the 30s-TTL-CACHED mempool accessors (getMempoolSummary /
//     getFeeHistogram), so it's ONE read per tick per PROCESS — never a
//     per-connection cost — and it never forces a fresh network refresh. In
//     steady state the cache absorbs most ticks, so the underlying chain is hit
//     at most about once per cache TTL, not once per 5s.

import { getChain } from './chain';
import { mempoolSubscriberCount, publish } from './liveHub';
import { childLogger } from './logger';
import type { FeeHistogram } from '$lib/types';

const log = childLogger('live-tickers');

const TICK_MS = 5_000;

let timer: ReturnType<typeof setInterval> | null = null;
let inFlight = false;

/** Last emitted signature, so an unchanged mempool never re-broadcasts. */
let last: { count: number | null; vsizeVb: number | null; histogramKey: string } | null = null;

function histogramKey(h: FeeHistogram | null): string {
	return h ? JSON.stringify(h) : '';
}

/**
 * Run one mempool sample. Reads the cached summary + fee histogram (each
 * tolerated independently — an Electrum-only or Core-only backend still yields
 * a partial frame), projects the next-blocks view from the histogram (a pure,
 * local transform — no extra fetch), diffs against the last emitted frame, and
 * publishes a broadcast `mempool` frame ONLY on change. Returns true if it
 * published. Never throws. Exported for deterministic testing (call it directly
 * rather than driving the timer).
 */
export async function runMempoolTick(): Promise<boolean> {
	if (inFlight) return false;
	// Dormant while nobody wants the topic: no chain read, no frame. This is the
	// load-bearing "idle instance pays nothing" guard.
	if (mempoolSubscriberCount() === 0) return false;
	inFlight = true;
	try {
		const chain = getChain();

		// Summary is Core-only and throws when Core isn't configured; the histogram
		// is Electrum-sourced and returns null on an empty mempool. Tolerate each
		// independently so a single-backend deploy still gets a useful frame.
		let count: number | null = null;
		let vsizeVb: number | null = null;
		try {
			const summary = await chain.getMempoolSummary();
			count = summary.txCount;
			vsizeVb = summary.vsize;
		} catch {
			// No Core / momentarily unavailable — leave the counters null.
		}

		let histogram: FeeHistogram | null = null;
		try {
			histogram = await chain.getFeeHistogram();
		} catch {
			histogram = null;
		}

		// Nothing to say — no backend answered this tick.
		if (count === null && vsizeVb === null && histogram === null) return false;

		const key = histogramKey(histogram);
		if (last && last.count === count && last.vsizeVb === vsizeVb && last.histogramKey === key) {
			return false; // unchanged since the last emitted frame
		}
		last = { count, vsizeVb, histogramKey: key };

		// Projection is derived from the histogram we already hold (pass it in so
		// getMempoolBlocks doesn't re-fetch — cairn-6efi.1, U3). Best-effort.
		let mempoolBlocks = null;
		try {
			mempoolBlocks = await chain.getMempoolBlocks(histogram);
		} catch {
			mempoolBlocks = null;
		}

		publish(
			'mempool',
			{ broadcast: true },
			{ count, vsizeVb, feeHistogram: histogram, mempoolBlocks, updatedAt: Date.now() }
		);
		return true;
	} catch (e) {
		log.warn({ err: e }, 'mempool tick failed');
		return false;
	} finally {
		inFlight = false;
	}
}

/** Start the shared ticker. Idempotent; the interval is unref'd so it never
 *  keeps the process alive on its own. */
export function startLiveTickers(): void {
	if (timer) return;
	timer = setInterval(() => void runMempoolTick(), TICK_MS);
	timer.unref?.();
}

/** Stop the ticker and forget the last-emitted signature (engine stop / tests). */
export function stopLiveTickers(): void {
	if (timer) {
		clearInterval(timer);
		timer = null;
	}
	last = null;
	inFlight = false;
}

/** Test hook: drop the last-emitted signature so the next tick always emits. */
export function resetLiveTickersForTest(): void {
	last = null;
	inFlight = false;
}
