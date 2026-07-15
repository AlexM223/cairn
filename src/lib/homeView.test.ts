import { describe, it, expect } from 'vitest';
import { deriveHomeHealth, shouldShowRecentActivity, shouldShowWalletList } from './homeView';

describe('shouldShowWalletList', () => {
	it('hides the list with zero wallets', () => {
		expect(shouldShowWalletList(0)).toBe(false);
	});

	it('hides the list with exactly one wallet (clean Muun-style hero)', () => {
		expect(shouldShowWalletList(1)).toBe(false);
	});

	it('shows the compact list once there are 2 wallets', () => {
		expect(shouldShowWalletList(2)).toBe(true);
	});

	it('shows the compact list for N > 2 wallets', () => {
		expect(shouldShowWalletList(7)).toBe(true);
	});
});

describe('shouldShowRecentActivity', () => {
	it('omits the RECENT section entirely when empty', () => {
		expect(shouldShowRecentActivity(0)).toBe(false);
	});

	it('shows RECENT once there is at least one item', () => {
		expect(shouldShowRecentActivity(1)).toBe(true);
	});

	it('shows RECENT for many items', () => {
		expect(shouldShowRecentActivity(42)).toBe(true);
	});
});

describe('deriveHomeHealth', () => {
	it('reads "All good" when nothing needs attention', () => {
		const h = deriveHomeHealth({ unbackedCount: 0, chainHealthy: true });
		expect(h).toEqual({ ok: true, label: 'Health · All good', issueCount: 0 });
	});

	it('flags a single unbacked wallet as one issue', () => {
		const h = deriveHomeHealth({ unbackedCount: 1, chainHealthy: true });
		expect(h).toEqual({ ok: false, label: 'Health · 1 needs attention', issueCount: 1 });
	});

	it('flags an unhealthy chain transport as one issue even with zero unbacked wallets', () => {
		const h = deriveHomeHealth({ unbackedCount: 0, chainHealthy: false });
		expect(h).toEqual({ ok: false, label: 'Health · 1 needs attention', issueCount: 1 });
	});

	it('sums multiple simultaneous issues', () => {
		const h = deriveHomeHealth({ unbackedCount: 2, chainHealthy: false });
		expect(h).toEqual({ ok: false, label: 'Health · 3 needs attention', issueCount: 3 });
	});

	it('never goes negative on a malformed unbacked count', () => {
		const h = deriveHomeHealth({ unbackedCount: -5, chainHealthy: true });
		expect(h).toEqual({ ok: true, label: 'Health · All good', issueCount: 0 });
	});
});
