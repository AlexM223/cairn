import { describe, expect, it } from 'vitest';
import { PRIMARY_NAV, accountMenuLinks, isNavActive } from './nav';

describe('PRIMARY_NAV', () => {
	it('has exactly three destinations: Home, Wallets, Activity', () => {
		expect(PRIMARY_NAV.map((i) => i.href)).toEqual(['/', '/wallets', '/activity']);
		expect(PRIMARY_NAV.map((i) => i.label)).toEqual(['Home', 'Wallets', 'Activity']);
	});

	it('never contains the account-menu destinations', () => {
		const hrefs = PRIMARY_NAV.map((i) => i.href);
		for (const gone of ['/explorer', '/mining', '/admin', '/settings']) {
			expect(hrefs).not.toContain(gone);
		}
	});
});

describe('accountMenuLinks', () => {
	it('gives admins the full set, in menu order', () => {
		expect(accountMenuLinks({ isAdmin: true, flags: {} })).toEqual([
			{ href: '/explorer', label: 'Explore the blockchain' },
			{ href: '/mining', label: 'Mining' },
			{ href: '/admin', label: 'Health' },
			{ href: '/settings', label: 'Settings' }
		]);
	});

	it('hides Health (/admin) from non-admins', () => {
		const hrefs = accountMenuLinks({ isAdmin: false, flags: {} }).map((l) => l.href);
		expect(hrefs).not.toContain('/admin');
		expect(hrefs).toContain('/settings');
	});

	it('labels the admin surface "Health", not "Node"', () => {
		const admin = accountMenuLinks({ isAdmin: true }).find((l) => l.href === '/admin');
		expect(admin?.label).toBe('Health');
	});

	it('drops Explorer when the explorer feature flag is off', () => {
		const hrefs = accountMenuLinks({ isAdmin: true, flags: { explorer: false } }).map(
			(l) => l.href
		);
		expect(hrefs).not.toContain('/explorer');
	});

	it('drops Mining when the mining feature flag is off', () => {
		const hrefs = accountMenuLinks({ isAdmin: true, flags: { mining: false } }).map((l) => l.href);
		expect(hrefs).not.toContain('/mining');
	});

	it('treats missing flags as enabled (same default as the old rail gating)', () => {
		const hrefs = accountMenuLinks({ isAdmin: false }).map((l) => l.href);
		expect(hrefs).toContain('/explorer');
		expect(hrefs).toContain('/mining');
	});
});

describe('isNavActive', () => {
	it('matches Home only on the exact root', () => {
		expect(isNavActive('/', '/')).toBe(true);
		expect(isNavActive('/', '/wallets')).toBe(false);
	});

	it('prefix-matches sections on their subroutes, path-segment safe', () => {
		expect(isNavActive('/wallets', '/wallets')).toBe(true);
		expect(isNavActive('/wallets', '/wallets/5/send')).toBe(true);
		expect(isNavActive('/wallets', '/walletsmith')).toBe(false);
		expect(isNavActive('/activity', '/activity')).toBe(true);
		expect(isNavActive('/activity', '/')).toBe(false);
	});
});
