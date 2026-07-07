// deriveSyncStatus (cairn-koy4.11) — the phase/percent brain behind the
// first-sync screen. Pins the phase ladder (connecting → history → scanning →
// synced, with unreachable as the failure plateau), the percent bands, and
// the year-note selection, so a refactor can't quietly turn the screen into a
// fabricated progress bar.

import { describe, it, expect } from 'vitest';
import { deriveSyncStatus, type SyncInputs } from './syncStatus';

function inputs(overrides: Partial<SyncInputs> = {}): SyncInputs {
	return {
		historyDone: false,
		fetchActive: false,
		consecutiveFailures: 0,
		tipHeight: null,
		epochsKnown: 0,
		epochsTotal: 0,
		lastKnownTime: null,
		scan: null,
		...overrides
	};
}

describe('deriveSyncStatus', () => {
	it('starts at connecting while no tip and no progress', () => {
		const s = deriveSyncStatus(inputs());
		expect(s.phase).toBe('connecting');
		expect(s.percent).toBe(2);
	});

	it('moves to history once a tip is known, scaling percent with epochs', () => {
		const early = deriveSyncStatus(
			inputs({ tipHeight: 956_237, epochsTotal: 475, epochsKnown: 0, fetchActive: true })
		);
		expect(early.phase).toBe('history');
		expect(early.percent).toBe(4);

		const mid = deriveSyncStatus(
			inputs({ tipHeight: 956_237, epochsTotal: 475, epochsKnown: 238, fetchActive: true })
		);
		expect(mid.phase).toBe('history');
		expect(mid.percent).toBeGreaterThan(early.percent);
		expect(mid.percent).toBeLessThan(88);
	});

	it('is history (not connecting) when progress exists but the tip lookup is down', () => {
		const s = deriveSyncStatus(
			inputs({ tipHeight: null, epochsTotal: 475, epochsKnown: 100, fetchActive: true })
		);
		expect(s.phase).toBe('history');
	});

	it('plateaus at unreachable after repeated failures with no active fetch', () => {
		const s = deriveSyncStatus(
			inputs({ consecutiveFailures: 2, epochsTotal: 475, epochsKnown: 100 })
		);
		expect(s.phase).toBe('unreachable');
		// Frozen at the progress the last attempt reached, not reset to zero.
		expect(s.percent).toBeGreaterThan(4);
	});

	it('failures during an active retry still count as history in flight', () => {
		const s = deriveSyncStatus(
			inputs({
				consecutiveFailures: 2,
				fetchActive: true,
				tipHeight: 956_237,
				epochsTotal: 475,
				epochsKnown: 100
			})
		);
		expect(s.phase).toBe('history');
	});

	it('shows scanning between history-done and baseline-done', () => {
		const s = deriveSyncStatus(
			inputs({
				historyDone: true,
				tipHeight: 956_237,
				epochsTotal: 475,
				epochsKnown: 475,
				scan: { started: true, baselined: false, total: 120, done: 60 }
			})
		);
		expect(s.phase).toBe('scanning');
		expect(s.percent).toBe(93); // 88 + 10 * 0.5
	});

	it('is synced when history is done and the scan is settled or absent', () => {
		// No wallets → nothing to scan.
		const noWallets = deriveSyncStatus(
			inputs({
				historyDone: true,
				tipHeight: 956_237,
				scan: { started: true, baselined: true, total: 0, done: 0 }
			})
		);
		expect(noWallets.phase).toBe('synced');
		expect(noWallets.percent).toBe(100);

		// Watcher not started yet (boot delay) → don't hold the user hostage.
		const notStarted = deriveSyncStatus(inputs({ historyDone: true, tipHeight: 956_237 }));
		expect(notStarted.phase).toBe('synced');

		// Scan fully done.
		const done = deriveSyncStatus(
			inputs({
				historyDone: true,
				tipHeight: 956_237,
				scan: { started: true, baselined: true, total: 120, done: 120 }
			})
		);
		expect(done.phase).toBe('synced');
	});

	it('derives the year note from the newest boundary timestamp', () => {
		// 2017-06-01 UTC — SegWit summer.
		const s = deriveSyncStatus(
			inputs({
				tipHeight: 956_237,
				epochsTotal: 475,
				epochsKnown: 240,
				fetchActive: true,
				lastKnownTime: Date.UTC(2017, 5, 1) / 1000
			})
		);
		expect(s.verifyingYear).toBe(2017);
		expect(s.verifyingNote).toBe('SegWit summer');
	});

	it('leaves the note null before any boundary is known', () => {
		const s = deriveSyncStatus(inputs({ tipHeight: 956_237, epochsTotal: 475 }));
		expect(s.verifyingYear).toBeNull();
		expect(s.verifyingNote).toBeNull();
	});
});
