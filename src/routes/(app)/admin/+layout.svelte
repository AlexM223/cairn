<script lang="ts">
	import { page } from '$app/state';
	import GroveField from '$lib/components/heartwood/GroveField.svelte';
	import EyebrowBreadcrumb from '$lib/components/heartwood/EyebrowBreadcrumb.svelte';

	let { data, children } = $props();

	// Users/Invites are multi-user MANAGEMENT surfaces — hidden outright in solo
	// mode rather than shown-but-disabled (docs/SOLO-MODE-UMBREL-AUTOADMIN-PLAN.md
	// Part 2). The routes themselves 404 via assertTeamMode() regardless of this
	// list, so this is purely "don't advertise a tab that 404s."
	const tabs = $derived(
		[
			{ href: '/admin', label: 'Overview' },
			{ href: '/admin/activity', label: 'Activity' },
			{ href: '/admin/users', label: 'Users', teamOnly: true },
			{ href: '/admin/invites', label: 'Invites', teamOnly: true },
			{ href: '/admin/settings', label: 'Settings' },
			{ href: '/admin/feature-flags', label: 'Feature flags' },
			{ href: '/admin/notifications', label: 'Notifications' },
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

	// One eyebrow for the whole admin surface: `NODE` on the overview,
	// `NODE · <SECTION>` on subpages. Reused centered in the mobile flow header
	// (the app shell already renders the back circle for /admin/** on mobile).
	const currentTab = $derived(tabs.find((t) => t.href !== '/admin' && isActive(t.href)) ?? null);
</script>

<!-- Whisper-volume grove field behind the whole admin surface. The wrapper is
     the positioning context per GroveField's usage contract; it spans the
     content column (the shell owns the viewport chrome). -->
<div class="admin-shell">
	<GroveField volume="whisper" />
	<div class="admin-content">
		<div class="admin-eyebrow">
			<EyebrowBreadcrumb path={['Node']} current={currentTab?.label} />
		</div>

		<nav class="admin-nav" aria-label="Admin sections">
			{#each tabs as tab (tab.href)}
				<a href={tab.href} class="toggle" class:active={isActive(tab.href)}>{tab.label}</a>
			{/each}
		</nav>

		{@render children()}
	</div>
</div>

<style>
	.admin-shell {
		position: relative;
	}

	/* Dense pages narrow to the spec's 760px column inside the shell's 940. */
	.admin-content {
		position: relative;
		z-index: 1;
		max-width: 760px;
		margin: 0 auto;
	}

	.admin-eyebrow {
		margin-bottom: 16px;
	}

	/* Text-toggle grammar (the spec's tab row): active = bright copper on a
	   faint copper pill, inactive = faint text. No underlines, no borders. */
	.admin-nav {
		display: flex;
		gap: 4px;
		flex-wrap: wrap;
		margin-bottom: 30px;
	}

	.toggle {
		padding: 6px 13px;
		border-radius: var(--radius-toggle);
		font-size: 13px;
		font-weight: 500;
		color: var(--text-faint);
		white-space: nowrap;
		transition:
			color 120ms var(--ease),
			background 120ms var(--ease);
	}

	.toggle:hover {
		color: var(--text-secondary);
	}

	.toggle.active {
		color: var(--accent-bright);
		background: rgba(232, 147, 90, 0.1);
	}

	@media (max-width: 900px) {
		/* The shell's mobile flow header already shows the back circle; the
		   eyebrow centers below it per the flow-page grammar. */
		.admin-eyebrow {
			display: flex;
			justify-content: center;
			margin-bottom: 14px;
		}

		.admin-nav {
			flex-wrap: nowrap;
			overflow-x: auto;
			scrollbar-width: none;
			margin-bottom: 24px;
		}

		.toggle {
			font-size: 12.5px;
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
