import { describe, expect, it } from 'vitest';
import { primaryNav, accountMenuLinks, isNavActive } from './nav';

describe('primaryNav', () => {
	it('gives Home + Wallets + Mining + Explorer when both flags resolve on', () => {
		expect(primaryNav({ flags: {} }).map((i) => i.href)).toEqual([
			'/',
			'/wallets',
			'/mining',
			'/explorer'
		]);
		expect(primaryNav({ flags: {} }).map((i) => i.label)).toEqual([
			'Home',
			'Wallets',
			'Mining',
			'Explorer'
		]);
	});

	it('treats missing flags as enabled (same default requireFeature uses)', () => {
		const hrefs = primaryNav({}).map((i) => i.href);
		expect(hrefs).toContain('/mining');
		expect(hrefs).toContain('/explorer');
	});

	it('drops Mining when the mining flag resolves off', () => {
		const hrefs = primaryNav({ flags: { mining: false } }).map((i) => i.href);
		expect(hrefs).not.toContain('/mining');
		expect(hrefs).toContain('/explorer');
	});

	it('drops Explorer when the explorer flag resolves off', () => {
		const hrefs = primaryNav({ flags: { explorer: false } }).map((i) => i.href);
		expect(hrefs).not.toContain('/explorer');
		expect(hrefs).toContain('/mining');
	});

	it('is Home + Wallets only when both flags resolve off', () => {
		expect(primaryNav({ flags: { mining: false, explorer: false } }).map((i) => i.href)).toEqual([
			'/',
			'/wallets'
		]);
	});

	it('never contains the account-menu-only destinations', () => {
		const hrefs = primaryNav({ flags: {} }).map((i) => i.href);
		for (const gone of ['/activity', '/admin', '/settings']) {
			expect(hrefs).not.toContain(gone);
		}
	});
});

describe('accountMenuLinks', () => {
	it('gives admins Activity, Health, Settings, in that order', () => {
		expect(accountMenuLinks({ isAdmin: true, flags: {} })).toEqual([
			{ href: '/activity', label: 'Activity' },
			{ href: '/admin', label: 'Health' },
			{ href: '/settings', label: 'Settings' }
		]);
	});

	it('hides Health (/admin) from non-admins', () => {
		const hrefs = accountMenuLinks({ isAdmin: false, flags: {} }).map((l) => l.href);
		expect(hrefs).not.toContain('/admin');
		expect(hrefs).toContain('/activity');
		expect(hrefs).toContain('/settings');
	});

	it('labels the admin surface "Health", not "Node"', () => {
		const admin = accountMenuLinks({ isAdmin: true }).find((l) => l.href === '/admin');
		expect(admin?.label).toBe('Health');
	});

	it('no longer carries Explorer/Mining — those are primary nav items now', () => {
		const hrefs = accountMenuLinks({ isAdmin: true, flags: {} }).map((l) => l.href);
		expect(hrefs).not.toContain('/explorer');
		expect(hrefs).not.toContain('/mining');
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
		expect(isNavActive('/mining', '/mining')).toBe(true);
		expect(isNavActive('/mining', '/mining/pool')).toBe(true);
		expect(isNavActive('/explorer', '/explorer/tx/abc')).toBe(true);
		expect(isNavActive('/settings', '/settings')).toBe(true);
	});
});
