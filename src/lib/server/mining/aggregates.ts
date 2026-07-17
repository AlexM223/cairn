/**
 * In-memory share accounting for the mining engine. Every accepted/rejected
 * share updates ONLY memory here — there are NO per-share DB writes (the
 * sync-SQLite contention hazard, cairn-xlrm). A single batched transaction every
 * 15s (unref'd timer) flushes:
 *   - incremental deltas into mining_workers (cumulative counters, MAX best),
 *   - one row per CLOSED 1-minute bucket into mining_stats (per-worker + a pool
 *     row with user_id NULL), each minute written exactly once.
 * mining_stats older than 7 days is pruned opportunistically on flush.
 *
 * The live "now" values the read models show come straight from this module's
 * in-memory state (fresh to the last share), never the up-to-15s-stale DB
 * mirror; the DB mirror exists for durability, the admin hashrate series, and
 * the all-time best-share baseline.
 */
import { db } from '../db';
import { childLogger } from '../logger';
import { estimateHashrate } from '$lib/shared/hashrate';
import type { ShareEvent, RejectEvent } from './types';

const log = childLogger('mining:aggregates');

const FLUSH_INTERVAL_MS = 15_000;
const BUCKET_MS = 60_000;
/** Rolling per-worker share-window bounds: prune older than 24h, and hard-cap
 *  entries so a fast miner can't grow one worker's array without bound. */
const WINDOW_MAX_AGE_MS = 86_400_000;
const WINDOW_MAX_ENTRIES = 5_000;
const STATS_RETENTION_MS = 7 * 86_400_000;

/** Hashrate averaging windows (seconds). */
const WIN_NOW_SEC = 600;
const WIN_1H_SEC = 3_600;
const WIN_24H_SEC = 86_400;

interface WorkerState {
	userId: number;
	worker: string;
	sharesAccepted: number;
	sharesStale: number;
	sharesRejected: number;
	sumDifficulty: number;
	bestShareDiff: number;
	currentDiff: number;
	firstShareAtMs: number | null;
	lastShareAtMs: number | null;
	/** {t: epoch ms, d: announce-time difficulty} for accepted shares. */
	window: { t: number; d: number }[];
	/** Cumulative counters last written to mining_workers — flush writes the delta. */
	flushed: { accepted: number; stale: number; rejected: number; sumDifficulty: number };
}

interface Bucket {
	perWorker: Map<string, { userId: number; worker: string; shares: number; sumWeight: number }>;
	poolShares: number;
	poolSumWeight: number;
}

export interface WorkerLive {
	userId: number;
	worker: string;
	sharesAccepted: number;
	sharesStale: number;
	sharesRejected: number;
	sumDifficulty: number;
	bestShareDiff: number;
	currentDiff: number;
	firstShareAtMs: number | null;
	lastShareAtMs: number | null;
	hashrate: { now: number; h1: number; h24: number };
}

function keyOf(userId: number, worker: string): string {
	return `${userId}:${worker}`;
}

export class MiningAggregates {
	private workers = new Map<string, WorkerState>();
	/** Open + not-yet-flushed 1-minute buckets, keyed by bucket-start epoch ms. */
	private buckets = new Map<number, Bucket>();
	private flushTimer: NodeJS.Timeout | null = null;
	private lastRetentionSweep = 0;

	private stateFor(userId: number, worker: string): WorkerState {
		const k = keyOf(userId, worker);
		let s = this.workers.get(k);
		if (!s) {
			s = {
				userId,
				worker,
				sharesAccepted: 0,
				sharesStale: 0,
				sharesRejected: 0,
				sumDifficulty: 0,
				bestShareDiff: 0,
				currentDiff: 0,
				firstShareAtMs: null,
				lastShareAtMs: null,
				window: [],
				flushed: { accepted: 0, stale: 0, rejected: 0, sumDifficulty: 0 }
			};
			this.workers.set(k, s);
		}
		return s;
	}

	private bucketFor(tMs: number): Bucket {
		const start = Math.floor(tMs / BUCKET_MS) * BUCKET_MS;
		let b = this.buckets.get(start);
		if (!b) {
			b = { perWorker: new Map(), poolShares: 0, poolSumWeight: 0 };
			this.buckets.set(start, b);
		}
		return b;
	}

	/** Record an accepted share (from MiningPool.onShare). Memory only. */
	recordShare(e: ShareEvent): void {
		const s = this.stateFor(e.userId, e.worker);
		const d = Number.isFinite(e.difficulty) && e.difficulty > 0 ? e.difficulty : 0;
		s.sharesAccepted += 1;
		s.sumDifficulty += d;
		s.currentDiff = d;
		if (s.firstShareAtMs === null) s.firstShareAtMs = e.timestampMs;
		s.lastShareAtMs = e.timestampMs;
		if (d > s.bestShareDiff) s.bestShareDiff = d;
		s.window.push({ t: e.timestampMs, d });
		this.pruneWindow(s);

		const b = this.bucketFor(e.timestampMs);
		const bk = keyOf(e.userId, e.worker);
		let bw = b.perWorker.get(bk);
		if (!bw) {
			bw = { userId: e.userId, worker: e.worker, shares: 0, sumWeight: 0 };
			b.perWorker.set(bk, bw);
		}
		bw.shares += 1;
		bw.sumWeight += d;
		b.poolShares += 1;
		b.poolSumWeight += d;
	}

	/** Record a rejected submit (from MiningPool.onReject). 'stale' → stale
	 *  counter; every other reason → rejected counter. Memory only. */
	recordReject(e: RejectEvent): void {
		if (e.userId === undefined || e.worker === undefined) return;
		const s = this.stateFor(e.userId, e.worker);
		if (e.reason === 'stale') s.sharesStale += 1;
		else s.sharesRejected += 1;
	}

	private pruneWindow(s: WorkerState): void {
		const cutoff = Date.now() - WINDOW_MAX_AGE_MS;
		// Drop by age from the front (entries are appended in time order).
		let i = 0;
		while (i < s.window.length && s.window[i].t < cutoff) i++;
		if (i > 0) s.window.splice(0, i);
		// Hard cap: drop oldest beyond the ceiling.
		if (s.window.length > WINDOW_MAX_ENTRIES) {
			s.window.splice(0, s.window.length - WINDOW_MAX_ENTRIES);
		}
	}

	private windowHashrate(s: WorkerState, windowSec: number, now: number): number {
		const cutoff = now - windowSec * 1000;
		let sum = 0;
		for (let i = s.window.length - 1; i >= 0; i--) {
			if (s.window[i].t < cutoff) break;
			sum += s.window[i].d;
		}
		return estimateHashrate(sum, windowSec);
	}

	private toLive(s: WorkerState, now: number): WorkerLive {
		return {
			userId: s.userId,
			worker: s.worker,
			sharesAccepted: s.sharesAccepted,
			sharesStale: s.sharesStale,
			sharesRejected: s.sharesRejected,
			sumDifficulty: s.sumDifficulty,
			bestShareDiff: s.bestShareDiff,
			currentDiff: s.currentDiff,
			firstShareAtMs: s.firstShareAtMs,
			lastShareAtMs: s.lastShareAtMs,
			hashrate: {
				now: this.windowHashrate(s, WIN_NOW_SEC, now),
				h1: this.windowHashrate(s, WIN_1H_SEC, now),
				h24: this.windowHashrate(s, WIN_24H_SEC, now)
			}
		};
	}

	/** Live per-worker view for one user (in-memory, fresh to the last share). */
	liveWorkers(userId: number): WorkerLive[] {
		const now = Date.now();
		const out: WorkerLive[] = [];
		for (const s of this.workers.values()) {
			if (s.userId === userId) out.push(this.toLive(s, now));
		}
		return out;
	}

	/** Live view of every worker across all users (admin). */
	liveAllMiners(): WorkerLive[] {
		const now = Date.now();
		return [...this.workers.values()].map((s) => this.toLive(s, now));
	}

	/** Best session share difficulty seen for a user, across their workers. */
	sessionBest(userId: number): number {
		let best = 0;
		for (const s of this.workers.values()) {
			if (s.userId === userId && s.bestShareDiff > best) best = s.bestShareDiff;
		}
		return best;
	}

	// -------------------------------------------------------------------- flush

	startFlushTimer(): void {
		if (this.flushTimer) return;
		this.flushTimer = setInterval(() => this.flush(), FLUSH_INTERVAL_MS);
		this.flushTimer.unref?.();
	}

	stopFlushTimer(): void {
		if (this.flushTimer) {
			clearInterval(this.flushTimer);
			this.flushTimer = null;
		}
	}

	/**
	 * Batched persistence pass. One transaction: increment mining_workers by each
	 * worker's delta since the last flush, then append every CLOSED minute bucket
	 * to mining_stats. Never throws (logs and rolls back on error).
	 */
	flush(now = Date.now()): void {
		try {
			db.exec('BEGIN');
			try {
				this.flushWorkers();
				this.flushClosedBuckets(now);
				db.exec('COMMIT');
			} catch (e) {
				db.exec('ROLLBACK');
				throw e;
			}
		} catch (e) {
			log.error({ err: e }, 'aggregates flush failed');
			return;
		}
		this.maybeSweepRetention(now);
	}

	private flushWorkers(): void {
		const upsert = db.prepare(
			`INSERT INTO mining_workers
			   (user_id, worker_name, shares_accepted, shares_stale, shares_rejected,
			    sum_weight, best_share_diff, hashrate_est, current_diff, last_share_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(user_id, worker_name) DO UPDATE SET
			   shares_accepted = shares_accepted + excluded.shares_accepted,
			   shares_stale    = shares_stale + excluded.shares_stale,
			   shares_rejected = shares_rejected + excluded.shares_rejected,
			   sum_weight      = CAST(CAST(sum_weight AS REAL) + CAST(excluded.sum_weight AS REAL) AS TEXT),
			   best_share_diff = MAX(best_share_diff, excluded.best_share_diff),
			   hashrate_est    = excluded.hashrate_est,
			   current_diff    = excluded.current_diff,
			   last_share_at   = excluded.last_share_at`
		);
		const now = Date.now();
		for (const s of this.workers.values()) {
			const dA = s.sharesAccepted - s.flushed.accepted;
			const dS = s.sharesStale - s.flushed.stale;
			const dR = s.sharesRejected - s.flushed.rejected;
			const dW = s.sumDifficulty - s.flushed.sumDifficulty;
			if (dA === 0 && dS === 0 && dR === 0 && dW === 0 && s.lastShareAtMs === null) continue;
			const hashrateNow = this.windowHashrate(s, WIN_NOW_SEC, now);
			upsert.run(
				s.userId,
				s.worker,
				dA,
				dS,
				dR,
				String(dW),
				s.bestShareDiff,
				hashrateNow,
				s.currentDiff,
				s.lastShareAtMs === null ? null : new Date(s.lastShareAtMs).toISOString()
			);
			s.flushed.accepted = s.sharesAccepted;
			s.flushed.stale = s.sharesStale;
			s.flushed.rejected = s.sharesRejected;
			s.flushed.sumDifficulty = s.sumDifficulty;
		}
	}

	private flushClosedBuckets(now: number): void {
		const insert = db.prepare(
			`INSERT INTO mining_stats (bucket_start, user_id, worker_name, shares, sum_weight, hashrate_est)
			 VALUES (?, ?, ?, ?, ?, ?)`
		);
		for (const [start, b] of [...this.buckets.entries()]) {
			// Only write a bucket once its full minute has elapsed.
			if (start + BUCKET_MS > now) continue;
			const bucketIso = new Date(start).toISOString();
			for (const bw of b.perWorker.values()) {
				insert.run(
					bucketIso,
					bw.userId,
					bw.worker,
					bw.shares,
					String(bw.sumWeight),
					estimateHashrate(bw.sumWeight, BUCKET_MS / 1000)
				);
			}
			// Pool row: user_id NULL, worker_name NULL.
			insert.run(
				bucketIso,
				null,
				null,
				b.poolShares,
				String(b.poolSumWeight),
				estimateHashrate(b.poolSumWeight, BUCKET_MS / 1000)
			);
			this.buckets.delete(start);
		}
	}

	private maybeSweepRetention(now: number): void {
		// At most once an hour: prune aged mining_stats and in-memory windows.
		if (now - this.lastRetentionSweep < 3_600_000) return;
		this.lastRetentionSweep = now;
		try {
			const cutoff = new Date(now - STATS_RETENTION_MS).toISOString();
			db.prepare('DELETE FROM mining_stats WHERE bucket_start < ?').run(cutoff);
		} catch (e) {
			log.warn({ err: e }, 'mining_stats retention prune failed');
		}
		for (const s of this.workers.values()) this.pruneWindow(s);
	}

	/** Drop all in-memory state (engine stop / tests). Does NOT touch the DB. */
	reset(): void {
		this.workers.clear();
		this.buckets.clear();
		this.lastRetentionSweep = 0;
	}
}
