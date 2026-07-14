import { describe, it, expect, vi, afterEach } from 'vitest';
import { startBackoffPoll, type PollOutcome } from './backoffPoll';

afterEach(() => {
	vi.useRealTimers();
});

describe('startBackoffPoll (cairn-1f0a)', () => {
	it('polls at the base cadence while results stay healthy', async () => {
		vi.useFakeTimers();
		const times: number[] = [];
		const cancel = startBackoffPoll({
			poll: async () => {
				times.push(Date.now());
				return 'reset';
			},
			baseMs: 1000,
			maxMs: 30000
		});

		// Immediate first run, then one per base interval.
		await vi.advanceTimersByTimeAsync(0);
		await vi.advanceTimersByTimeAsync(1000);
		await vi.advanceTimersByTimeAsync(1000);
		cancel();

		expect(times.length).toBe(3);
		// Spaced exactly baseMs apart — no drift, no storm.
		expect(times[1] - times[0]).toBe(1000);
		expect(times[2] - times[1]).toBe(1000);
	});

	it('backs off exponentially up to the cap on a sustained error condition', async () => {
		vi.useFakeTimers();
		const times: number[] = [];
		startBackoffPoll({
			poll: async () => {
				times.push(Date.now());
				return 'backoff';
			},
			baseMs: 1000,
			maxMs: 8000
		});

		// Run 0 immediate. Subsequent gaps: 1000, 2000, 4000, 8000, 8000 (capped).
		await vi.advanceTimersByTimeAsync(0); // run 0
		await vi.advanceTimersByTimeAsync(1000); // run 1
		await vi.advanceTimersByTimeAsync(2000); // run 2
		await vi.advanceTimersByTimeAsync(4000); // run 3
		await vi.advanceTimersByTimeAsync(8000); // run 4
		await vi.advanceTimersByTimeAsync(8000); // run 5 (still capped)

		const gaps = times.slice(1).map((t, i) => t - times[i]);
		expect(gaps).toEqual([1000, 2000, 4000, 8000, 8000]);
	});

	it('does NOT storm: a fixed interval would fire far more often than backoff over the same span', async () => {
		vi.useFakeTimers();
		let calls = 0;
		startBackoffPoll({
			poll: async () => {
				calls++;
				return 'backoff';
			},
			baseMs: 1000,
			maxMs: 8000
		});

		// Over 30s a no-backoff 1s poller fires ~30 times; backoff caps the count.
		await vi.advanceTimersByTimeAsync(30_000);
		// runs at t=0,1,3,7,15,23 (,31 not yet) -> 6 calls in the first 30s.
		expect(calls).toBeLessThanOrEqual(7);
		expect(calls).toBeGreaterThanOrEqual(5);
	});

	it('resets to the base cadence the moment a result recovers', async () => {
		vi.useFakeTimers();
		const outcomes: PollOutcome[] = ['backoff', 'backoff', 'reset', 'reset'];
		const times: number[] = [];
		let i = 0;
		startBackoffPoll({
			poll: async () => {
				times.push(Date.now());
				return outcomes[Math.min(i++, outcomes.length - 1)];
			},
			baseMs: 1000,
			maxMs: 30000
		});

		await vi.advanceTimersByTimeAsync(0); // run 0 -> backoff, next in 1000
		await vi.advanceTimersByTimeAsync(1000); // run 1 -> backoff, next in 2000
		await vi.advanceTimersByTimeAsync(2000); // run 2 -> reset, next in 1000 (base)
		await vi.advanceTimersByTimeAsync(1000); // run 3 -> reset, next in 1000

		const gaps = times.slice(1).map((t, j) => t - times[j]);
		expect(gaps).toEqual([1000, 2000, 1000]);
	});

	it('stops polling entirely on a terminal result', async () => {
		vi.useFakeTimers();
		let calls = 0;
		startBackoffPoll({
			poll: async () => {
				calls++;
				return 'stop';
			},
			baseMs: 1000,
			maxMs: 30000
		});

		await vi.advanceTimersByTimeAsync(0);
		await vi.advanceTimersByTimeAsync(60_000);
		expect(calls).toBe(1);
	});

	it('treats a thrown poll as a backoff, not a crash', async () => {
		vi.useFakeTimers();
		const times: number[] = [];
		startBackoffPoll({
			poll: async () => {
				times.push(Date.now());
				throw new Error('fetch failed');
			},
			baseMs: 1000,
			maxMs: 8000
		});

		await vi.advanceTimersByTimeAsync(0);
		await vi.advanceTimersByTimeAsync(1000);
		await vi.advanceTimersByTimeAsync(2000);
		const gaps = times.slice(1).map((t, i) => t - times[i]);
		expect(gaps).toEqual([1000, 2000]);
	});

	it('cancel() stops further polls, including during an in-flight run', async () => {
		vi.useFakeTimers();
		let calls = 0;
		const cancel = startBackoffPoll({
			poll: async () => {
				calls++;
				return 'reset';
			},
			baseMs: 1000,
			maxMs: 30000
		});

		await vi.advanceTimersByTimeAsync(0); // run 0
		cancel();
		await vi.advanceTimersByTimeAsync(60_000);
		expect(calls).toBe(1);
	});

	it('immediate:false waits one base interval before the first poll', async () => {
		vi.useFakeTimers();
		let calls = 0;
		startBackoffPoll({
			poll: async () => {
				calls++;
				return 'reset';
			},
			baseMs: 1000,
			maxMs: 30000,
			immediate: false
		});

		await vi.advanceTimersByTimeAsync(0);
		expect(calls).toBe(0); // nothing yet
		await vi.advanceTimersByTimeAsync(1000);
		expect(calls).toBe(1);
	});
});
