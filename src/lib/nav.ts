// Primary-nav model (UX-REDESIGN-SPEC.md §2.7, cairn-gt05.4): exactly three
// primary destinations, identical on the desktop rail and the mobile tab row.
// Every other destination reaches the app through the account menu (the avatar
// is the single "everything else" escape hatch). Kept as a plain module so the
// derivation — 3 primaries, feature-flag gating, admin gating — is
// unit-testable away from the shell markup.

export type NavItem = { href: string; label: string; icon: string };
export type AccountMenuLink = { href: string; label: string };
export type FeatureFlags = Partial<Record<string, boolean>>;

/** The three primaries — same set on desktop and mobile, Home leftmost. The
 *  active item is the only accent-colored nav element (manifesto §2/§5). */
export const PRIMARY_NAV: NavItem[] = [
	{ href: '/', label: 'Home', icon: 'dashboard' },
	{ href: '/wallets', label: 'Wallets', icon: 'wallet' },
	{ href: '/activity', label: 'Activity', icon: 'activity' }
];

/**
 * The account menu's link entries, in menu order. A feature the user has no
 * access to is absent (not shown disabled) — the server-side gate
 * (requireFeature / admin auth) is the real boundary; hiding the link is the
 * courtesy. "Health" (the renamed Node/admin surface) is admin-only.
 *
 * Mining is not in the spec's §2.7 menu sketch, but it left the primary nav
 * here and would otherwise be unreachable — it keeps the account-menu slot the
 * mobile shell already gave it (cairn-vn43.5).
 */
export function accountMenuLinks(opts: {
	isAdmin: boolean;
	flags?: FeatureFlags | null;
}): AccountMenuLink[] {
	const flags = opts.flags ?? {};
	return [
		...(flags.explorer !== false ? [{ href: '/explorer', label: 'Explore the blockchain' }] : []),
		...(flags.mining !== false ? [{ href: '/mining', label: 'Mining' }] : []),
		...(opts.isAdmin ? [{ href: '/admin', label: 'Health' }] : []),
		{ href: '/settings', label: 'Settings' }
	];
}

/** Shared active-route test for rail rows and mobile tabs: exact match for
 *  Home, prefix match (path-segment safe) for everything else. */
export function isNavActive(href: string, pathname: string): boolean {
	if (href === '/') return pathname === '/';
	return pathname === href || pathname.startsWith(href + '/');
}
