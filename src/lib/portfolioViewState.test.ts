import { describe, it, expect } from 'vitest';
import { portfolioViewState } from './portfolioViewState';

describe('portfolioViewState', () => {
	it('is "ready" whenever a real snapshot exists, regardless of refresh outcome', () => {
		expect(portfolioViewState({ lastSyncedAt: 1_000, refreshFailed: false })).toBe('ready');
		// SWR: a later refresh failure must NOT hide the good cached data.
		expect(portfolioViewState({ lastSyncedAt: 1_000, refreshFailed: true })).toBe('ready');
	});

	it('is "first-sync" when never synced and the refresh has not failed yet', () => {
		// Covers both "not yet attempted" and "in flight".
		expect(portfolioViewState({ lastSyncedAt: null, refreshFailed: false })).toBe('first-sync');
	});

	it('is "unreachable" when never synced AND the refresh failed', () => {
		expect(portfolioViewState({ lastSyncedAt: null, refreshFailed: true })).toBe('unreachable');
	});

	it('treats a real zero timestamp as a genuine snapshot (never null-coalesced away)', () => {
		expect(portfolioViewState({ lastSyncedAt: 0, refreshFailed: true })).toBe('ready');
	});
});
