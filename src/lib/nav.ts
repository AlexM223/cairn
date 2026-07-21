// Primary-nav model (docs/UX-SIMPLIFICATION-SPEC.md §2, cairn-6c91u.1):
// dynamic 2-4 destinations, identical on the desktop rail and the mobile tab
// row. Home and Wallets are always present; Mining and Explorer appear only
// when their instance feature flag resolves true — the flag predicate here
// (`flags.x !== false`) MUST match the exact predicate `requireFeature()`
// resolves to, so nav-visible always implies route-reachable (spec R2/R5).
// Everything else (Health, Settings, Notifications, Activity) reaches the app
// through the gear icon (always present, → /settings) and the account menu.
// Kept as a plain module so the derivation is unit-testable away from the
// shell markup.

export type NavItem = { href: string; label: string; icon: string };
export type AccountMenuLink = { href: string; label: string };
export type FeatureFlags = Partial<Record<string, boolean>>;

/** Home + Wallets always; Mining/Explorer iff their instance flag isn't
 *  explicitly off — same set on desktop and mobile, Home leftmost. The
 *  active item is the only accent-colored nav element (manifesto §2/§5). */
export function primaryNav(opts: { flags?: FeatureFlags | null }): NavItem[] {
	const flags = opts.flags ?? {};
	return [
		{ href: '/', label: 'Home', icon: 'dashboard' },
		{ href: '/wallets', label: 'Wallets', icon: 'wallet' },
		...(flags.mining !== false ? [{ href: '/mining', label: 'Mining', icon: 'flame' }] : []),
		...(flags.explorer !== false ? [{ href: '/explorer', label: 'Explorer', icon: 'blocks' }] : [])
	];
}

/**
 * The account menu's navigable link entries, in menu order (spec §2.3,
 * decision 3): Notifications (opens an in-place panel, not a navigation) and
 * Terms/Sign out are rendered by the shell around this list, so together with
 * it the full menu order is Notifications, Activity, Health, Settings, Terms,
 * Sign out. A feature the user has no access to is absent (not shown
 * disabled) — the server-side gate (requireFeature / admin auth) is the real
 * boundary; hiding the link is the courtesy. "Health" (the renamed Node/admin
 * surface) is admin-only. Explorer/Mining left this menu — they're primary
 * nav items now.
 */
export function accountMenuLinks(opts: {
	isAdmin: boolean;
	flags?: FeatureFlags | null;
}): AccountMenuLink[] {
	return [
		{ href: '/activity', label: 'Activity' },
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
