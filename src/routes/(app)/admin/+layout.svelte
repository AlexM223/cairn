<script lang="ts">
	import { page } from '$app/state';
	import GroveField from '$lib/components/heartwood/GroveField.svelte';
	import EyebrowBreadcrumb from '$lib/components/heartwood/EyebrowBreadcrumb.svelte';

	let { data, children } = $props();

	// Users/Invites are multi-user MANAGEMENT surfaces — hidden outright in solo
	// mode rather than shown-but-disabled (docs/SOLO-MODE-UMBREL-AUTOADMIN-PLAN.md
	// Part 2). The routes themselves 404 via assertTeamMode() regardless of this
	// list.
	//
	// The persistent tab strip is GONE (UX Simplification Wave 3, cairn-6c91u.3,
	// docs/UX-SIMPLIFICATION-SPEC.md §5.2): the Health hub page body + its own
	// link rows are now the only navigation to these subpages — no permanent nav
	// row survives it. `sections` stays only as a lookup table so the eyebrow
	// below can still name whichever subpage is open (breadcrumb, not nav).
	const sections = $derived(
		[
			{ href: '/admin', label: 'Health' },
			{ href: '/admin/activity', label: 'Activity' },
			{ href: '/admin/users', label: 'Users', teamOnly: true },
			{ href: '/admin/invites', label: 'Invites', teamOnly: true },
			{ href: '/admin/settings', label: 'Settings' },
			{ href: '/admin/mining', label: 'Mining' },
			{ href: '/admin/feature-flags', label: 'Feature flags' },
			{ href: '/admin/notifications', label: 'Notification delivery' },
			{ href: '/admin/announcements', label: 'Announcements' },
			{ href: '/admin/referral-settings', label: 'Referrals' },
			{ href: '/admin/logs', label: 'Logs' },
			{ href: '/admin/backup', label: 'Backup' }
		].filter((tab) => !tab.teamOnly || data.instanceMode === 'team')
	);

	function isActive(href: string): boolean {
		if (href === '/admin') return page.url.pathname === '/admin';
		return page.url.pathname.startsWith(href);
	}

	// One eyebrow for the whole admin surface: `HEALTH` on the overview,
	// `HEALTH · <SECTION>` on subpages. Reused centered in the mobile flow header
	// (the app shell already renders the back circle for /admin/** on mobile).
	// Matches the app-shell nav label (Node -> Health, cairn-vxbk) — this
	// in-page eyebrow was the gap that rename left behind (cairn-3hwc8).
	// Looked up against ALL sections (not just strip tabs) so a directly-opened
	// collapsed route (e.g. /admin/logs) still names itself.
	const currentTab = $derived(sections.find((t) => t.href !== '/admin' && isActive(t.href)) ?? null);
</script>

<!-- Whisper-volume grove field behind the whole admin surface. The wrapper is
     the positioning context per GroveField's usage contract; it spans the
     content column (the shell owns the viewport chrome). -->
<div class="admin-shell">
	<GroveField volume="whisper" />
	<div class="admin-content">
		<div class="admin-eyebrow">
			<EyebrowBreadcrumb path={['Health']} current={currentTab?.label} />
		</div>

		<!-- No persistent tab strip (UX Simplification Wave 3, cairn-6c91u.3,
		     docs/UX-SIMPLIFICATION-SPEC.md §5.2): the Health hub page body + its
		     own link rows are the only navigation into these subpages now — a
		     plain single-column body, same for every breakpoint. -->
		<div class="admin-main">
			{@render children()}
		</div>
	</div>
</div>

<style>
	.admin-shell {
		position: relative;
	}

	/* The 760px cap is gone (docs/DESKTOP-LAYOUT-DESIGN.md §2): admin content
	   now fills the data measure set by the shell's lane-data on /admin, so
	   tables use the room they're given. Config subpages keep their own
	   reading-width forms. */
	.admin-content {
		position: relative;
		z-index: 1;
	}

	.admin-eyebrow {
		margin-bottom: 16px;
	}

	.admin-main {
		min-width: 0;
	}

	@media (max-width: 900px) {
		/* The shell's mobile flow header already shows the back circle; the
		   eyebrow centers below it per the flow-page grammar. */
		.admin-eyebrow {
			display: flex;
			justify-content: center;
			margin-bottom: 14px;
		}
	}

	/* ---------- Shared Heartwood admin grammar ----------
	   Global on purpose: every /admin subpage renders inside this layout and
	   reuses these classes, so the hairline-row reskin isn't re-declared in
	   eleven files. Prefixed hw- to avoid collisions. */

	/* A section: no card, no box — sections separate with whitespace and a
	   hairline. */
	:global(.hw-section) {
		padding: 26px 0;
		border-top: 1px solid var(--hairline);
		display: flex;
		flex-direction: column;
		gap: 14px;
	}

	:global(.hw-section:first-of-type),
	:global(.hw-section.no-rule) {
		border-top: none;
		padding-top: 0;
	}

	/* Section title: the spec's Inter 600 17px. */
	:global(.hw-title) {
		font-family: var(--font-ui);
		font-size: 17px;
		font-weight: 600;
		color: var(--text);
		letter-spacing: -0.01em;
	}

	/* Hairline rows ("hairlines, not boxes"). */
	:global(.hw-rows) {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
	}

	:global(.hw-row) {
		display: flex;
		align-items: center;
		gap: 16px;
		padding: 15px 0;
		border-bottom: 1px solid var(--hairline);
	}

	:global(.hw-row:last-child) {
		border-bottom: none;
	}
</style>
