<script lang="ts">
	// Heartwood desktop nav — the shell for >=900px. Extends the compact icon
	// rail (formerly HWRail, whose CSS carries over verbatim as the "compact
	// tier" rules below) into a full labeled sidebar at >=1160px, per
	// docs/DESKTOP-LAYOUT-DESIGN.md §1.
	//
	// One component, one DOM tree, morphed entirely by CSS across three states:
	//   - 901–1159px  → compact icon rail (byte-identical to the old HWRail).
	//   - >=1160px expanded  → 236px labeled sidebar (248px at >=1600px).
	//   - >=1160px collapsed → converges back to the compact rail.
	//   - <900px → display:none (mobile shell owns nav; untouched).
	// A single DOM tree keeps exactly one NotificationPanel mounted (one SSE
	// stream), which a two-component / show-hide split would have doubled.
	import { page } from '$app/state';
	import { onMount } from 'svelte';
	import Icon from '$lib/components/Icon.svelte';
	import NotificationPanel from '$lib/components/NotificationPanel.svelte';

	type NavItem = { href: string; label: string; icon: string };
	type User = { displayName: string; email: string; isAdmin: boolean };

	let {
		navItems,
		user,
		operatorName = null
	}: { navItems: NavItem[]; user: User; operatorName?: string | null } = $props();

	function isActive(href: string): boolean {
		if (href === '/') return page.url.pathname === '/';
		return page.url.pathname === href || page.url.pathname.startsWith(href + '/');
	}

	// Heartwood mark, detail="simple", eccentric pith — inlined here on purpose
	// (the shared HeartwoodMark component is being built in a parallel lane; a
	// later cleanup pass consolidates). Geometry ported from HeartwoodMark.dc.html:
	// per ring [r, strokeWidth, opacity], t = r/45, center drifts toward the pith.
	const MARK_RINGS = (
		[
			[44, 2.4, 0.95],
			[36, 1.2, 0.6],
			[27.5, 1.9, 0.85],
			[18.5, 1.2, 0.6],
			[10.5, 1.7, 0.8]
		] as const
	).map(([r, w, o]) => {
		const t = r / 45;
		return { cx: 49 + t * 2, cy: 45 + t * 7, rx: r, ry: r * 0.955, w, o };
	});

	let menuOpen = $state(false);
	let menuWrap = $state<HTMLDivElement | null>(null);

	// Collapse state (desktop only). SSR-safe read: default to expanded so the
	// server-rendered markup is stable, read the stored value in onMount (after
	// hydration), and gate the write-back $effect on `hydrated`. Svelte 5 user
	// effects run in source order, so an ungated persistence effect would fire
	// before onMount and clobber the saved value with the default — the hydrated
	// gate makes the first (pre-read) run a no-op. The collapsed class is only
	// applied once hydrated, trading a theoretically-possible one-frame flash
	// (in practice the read completes before first paint) for guaranteed
	// correctness. See docs/DESKTOP-LAYOUT-DESIGN.md §1.2.
	let collapsed = $state(false);
	let hydrated = $state(false);

	onMount(() => {
		try {
			collapsed = localStorage.getItem('hw.sidebar.collapsed') === '1';
		} catch {
			// storage blocked (private mode etc.) — stay expanded
		}
		hydrated = true;
	});

	$effect(() => {
		if (!hydrated) return;
		try {
			localStorage.setItem('hw.sidebar.collapsed', collapsed ? '1' : '0');
		} catch {
			// best-effort — persistence is a convenience, not a correctness need
		}
	});

	function onDocClick(e: MouseEvent) {
		if (menuOpen && menuWrap && !menuWrap.contains(e.target as Node)) menuOpen = false;
	}
	function onKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape') menuOpen = false;
	}
</script>

<svelte:window onclick={onDocClick} onkeydown={onKeydown} />

<aside class="rail" class:collapsed={hydrated && collapsed}>
	<a href="/" class="brand" aria-label="Home">
		<svg class="mark-svg" width="26" height="26" viewBox="0 0 100 100" aria-hidden="true">
			{#each MARK_RINGS as ring (ring.rx)}
				<ellipse
					cx={ring.cx}
					cy={ring.cy}
					rx={ring.rx}
					ry={ring.ry}
					fill="none"
					stroke="var(--accent)"
					stroke-width={ring.w}
					opacity={ring.o}
				/>
			{/each}
			<circle cx="49.3" cy="46" r="4" fill="var(--accent-core)" />
		</svg>
		<span class="wordmark">Heartwood</span>
	</a>

	<nav class="nav" aria-label="Main">
		{#each navItems as item (item.href)}
			<a
				href={item.href}
				class="nav-row"
				class:active={isActive(item.href)}
				title={item.label}
				aria-label={item.label}
				aria-current={isActive(item.href) ? 'page' : undefined}
			>
				<span class="nav-icon">
					{#if item.icon === 'explorer'}
						<!-- Explorer's three-concentric-circles icon is custom per the spec's
						     Assets section — Icon.svelte has nothing close. -->
						<svg
							width="19"
							height="19"
							viewBox="0 0 20 20"
							fill="none"
							stroke="currentColor"
							stroke-width="1.4"
							aria-hidden="true"
						>
							<circle cx="10" cy="10" r="7.5" />
							<circle cx="10" cy="10" r="4.5" />
							<circle cx="10" cy="10" r="1.4" fill="currentColor" stroke="none" />
						</svg>
					{:else}
						<Icon name={item.icon} size={19} strokeWidth={1.6} />
					{/if}
				</span>
				<span class="nav-label">{item.label}</span>
			</a>
		{/each}
	</nav>

	<div class="spacer"></div>

	<div class="foot">
		<!-- Epoch dial placeholder: static glyph from the design source. The inline
		     sync-status readout (§1.1's "Synced · block N") awaits the live sync
		     component (cairn-koy4.8) — the same reason HWRail kept the dial static.
		     We render the readout's structural slot with a neutral, non-fabricated
		     label rather than inventing a block height. -->
		<div class="sync-cluster">
			<svg class="dial" width="38" height="38" viewBox="0 0 34 34" aria-hidden="true">
				<circle cx="17" cy="17" r="5" fill="none" stroke="var(--accent)" stroke-width="1.1" opacity=".45" />
				<circle cx="17" cy="17" r="9" fill="none" stroke="var(--accent)" stroke-width="1.1" opacity=".6" />
				<circle cx="17" cy="17" r="13.5" fill="none" stroke="var(--border-subtle)" stroke-width="1.6" />
				<circle
					cx="17"
					cy="17"
					r="13.5"
					fill="none"
					stroke="var(--accent)"
					stroke-width="1.6"
					stroke-linecap="round"
					stroke-dasharray="27.5 57.3"
					transform="rotate(-90 17 17)"
					class="dial-arc"
				/>
				<circle cx="27.8" cy="10.7" r="2" fill="var(--accent-glow)" class="dial-tip" />
				<circle cx="17" cy="17" r="1.6" fill="var(--accent-core)" />
			</svg>
			<span class="sync-line">Chain sync</span>
		</div>

		<div class="notif-row">
			<NotificationPanel />
			<span class="foot-label">Alerts</span>
		</div>

		<div class="menu-wrap" bind:this={menuWrap}>
			<button
				type="button"
				class="account"
				aria-haspopup="true"
				aria-expanded={menuOpen}
				aria-label="Account menu"
				onclick={() => (menuOpen = !menuOpen)}
			>
				<span class="avatar">{user.displayName.slice(0, 1).toUpperCase()}</span>
				<span class="account-name truncate">{user.displayName}</span>
				<span class="account-chev"><Icon name="chevron-down" size={15} /></span>
			</button>
			{#if menuOpen}
				<div class="menu" role="menu">
					<div class="menu-user">
						<div class="menu-name truncate">{user.displayName}</div>
						<div class="menu-email truncate">{user.email}</div>
					</div>
					<a href="/settings" class="menu-item" role="menuitem" onclick={() => (menuOpen = false)}>
						Settings
					</a>
					<a href="/terms" class="menu-item" role="menuitem" onclick={() => (menuOpen = false)}>
						Terms
					</a>
					{#if operatorName}
						<a
							href="/terms"
							class="menu-note truncate"
							onclick={() => (menuOpen = false)}
							title="Operated by {operatorName}"
						>
							operated by <strong>{operatorName}</strong>
						</a>
					{/if}
					<form method="POST" action="/logout">
						<button class="menu-item menu-signout" role="menuitem">Sign out</button>
					</form>
				</div>
			{/if}
		</div>

		<button
			type="button"
			class="collapse-toggle"
			aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
			onclick={() => (collapsed = !collapsed)}
		>
			<Icon name={collapsed ? 'chevron-right' : 'chevron-left'} size={16} />
		</button>
	</div>
</aside>

<style>
	/* ============================================================
	   COMPACT TIER (default, 901–1159px, and >=1160px when collapsed)
	   Values carried over verbatim from the old HWRail so the laptop
	   tier stays byte-identical — do not drift these without re-checking
	   the <900 QA gate and the laptop-rail appearance.
	   ============================================================ */
	.rail {
		width: 92px;
		flex-shrink: 0;
		display: flex;
		flex-direction: column;
		align-items: center;
		padding: 22px 0 18px;
		border-right: 1px solid var(--hairline);
		background: var(--bg);
		position: sticky;
		top: 0;
		height: 100vh;
	}

	.brand {
		display: flex;
		align-items: center;
		justify-content: center;
		margin-bottom: 30px;
		color: inherit;
	}

	.mark-svg {
		flex-shrink: 0;
	}

	.wordmark {
		display: none;
	}

	.nav {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 4px;
	}

	.nav-row {
		width: 68px;
		height: 52px;
		border-radius: 11px;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 4px;
		/* Inactive = cool-neutral text token (DESIGN-MANIFESTO.md §2/§5 — the
		   one accent hue is reserved for the active item below); the nav-label
		   makes the meaning visible even in the compact tier (cairn-vtpu —
		   icon-only was illegible to first-timers). */
		color: var(--text-muted);
		background: transparent;
		transition:
			color 120ms var(--ease),
			background 120ms var(--ease);
	}

	.nav-row:hover {
		color: var(--text-secondary);
	}

	/* Defined after :hover so the active treatment wins on the current row. */
	.nav-row.active {
		color: var(--accent-bright);
		background: var(--accent-muted);
	}

	.nav-icon {
		display: flex;
		align-items: center;
		justify-content: center;
	}

	.nav-label {
		font-family: var(--font-ui);
		font-size: 10px;
		font-weight: 500;
		line-height: 1;
		letter-spacing: 0.01em;
		white-space: nowrap;
	}

	.spacer {
		flex: 1;
	}

	.foot {
		display: flex;
		flex-direction: column;
		align-items: center;
	}

	.sync-cluster {
		display: flex;
		align-items: center;
		justify-content: center;
		margin-bottom: 14px;
	}

	.dial {
		overflow: visible;
	}

	.sync-line {
		display: none;
	}

	/* Cool signal-sheen on the epoch dial's active arc (DESIGN-MANIFESTO.md §5
	   permits glow on the ring/dial family — it's the identity's own "signal
	   sheen," never a warm crypto-neon button glow). Token-mixed rather than a
	   literal rgb triplet so it can't drift from --accent again. */
	.dial-arc {
		filter: drop-shadow(0 0 3px color-mix(in srgb, var(--accent) 50%, transparent));
	}

	.dial-tip {
		animation: hwPulse 2.4s ease-in-out infinite;
	}

	.notif-row {
		display: flex;
		align-items: center;
		justify-content: center;
		margin-bottom: 10px;
	}

	.foot-label {
		display: none;
	}

	.menu-wrap {
		position: relative;
		display: flex;
	}

	.account {
		display: flex;
		align-items: center;
		background: none;
		border: none;
		padding: 0;
		cursor: pointer;
		color: inherit;
	}

	.avatar {
		width: 30px;
		height: 30px;
		border-radius: 50%;
		background: linear-gradient(135deg, var(--accent-dim), var(--accent));
		display: flex;
		align-items: center;
		justify-content: center;
		font: 600 12.5px var(--font-ui);
		color: var(--on-accent);
		flex-shrink: 0;
	}

	.account-name,
	.account-chev {
		display: none;
	}

	.collapse-toggle {
		display: none;
	}

	.menu {
		position: absolute;
		left: calc(100% + 12px);
		bottom: 0;
		width: 216px;
		background: var(--surface-elevated);
		border: 1px solid var(--border-control);
		border-radius: 12px;
		box-shadow: 0 10px 32px rgba(0, 0, 0, 0.45);
		padding: 6px;
		z-index: 50;
	}

	.menu-user {
		padding: 8px 10px 9px;
		border-bottom: 1px solid var(--hairline);
		margin-bottom: 4px;
	}

	.menu-name {
		font-size: 13px;
		font-weight: 600;
		color: var(--text);
	}

	.menu-email {
		font-size: 11.5px;
		color: var(--text-muted);
	}

	.menu-item {
		display: block;
		width: 100%;
		text-align: left;
		padding: 7px 10px;
		border: none;
		background: none;
		border-radius: 8px;
		font-family: var(--font-ui);
		font-size: 13px;
		font-weight: 500;
		color: var(--text-secondary);
		cursor: pointer;
		transition:
			background 120ms var(--ease),
			color 120ms var(--ease);
	}

	.menu-item:hover {
		background: color-mix(in srgb, var(--text) 4%, transparent);
		color: var(--text);
	}

	.menu-note {
		display: block;
		padding: 6px 10px 7px;
		font-size: 11px;
		color: var(--text-muted);
	}

	.menu-note strong {
		color: var(--text-secondary);
		font-weight: 500;
	}

	.menu-note:hover strong {
		color: var(--accent);
	}

	.menu-signout {
		color: var(--text-muted);
	}

	.menu-signout:hover {
		color: var(--error);
		background: var(--error-muted);
	}

	/* ============================================================
	   LABELED TIER (>=1160px, expanded only). Everything here is gated
	   on :not(.collapsed) so a collapsed sidebar falls straight back to
	   the compact tier above with zero override bleed.
	   ============================================================ */
	@media (min-width: 1160px) {
		.rail:not(.collapsed) {
			width: var(--sidebar-w);
			align-items: stretch;
			padding: 24px 14px 16px;
		}

		.rail:not(.collapsed) .brand {
			justify-content: flex-start;
			gap: 11px;
			padding: 0 8px;
			margin-bottom: 26px;
		}

		.rail:not(.collapsed) .wordmark {
			display: block;
			font-family: var(--font-serif);
			font-size: 19px;
			font-weight: 500;
			letter-spacing: -0.01em;
			color: var(--text-hero);
		}

		.rail:not(.collapsed) .nav {
			align-items: stretch;
			gap: 2px;
		}

		.rail:not(.collapsed) .nav-row {
			width: auto;
			height: 40px;
			flex-direction: row;
			justify-content: flex-start;
			gap: 12px;
			padding: 0 12px;
			border-radius: 9px;
			position: relative;
		}

		/* Quiet hover (inactive rows only): text-secondary is already set by the
		   base .nav-row:hover; add only the faint wash. No accent on hover —
		   accent marks "where you are," not "where the mouse is" (§1.1). */
		.rail:not(.collapsed) .nav-row:not(.active):hover {
			background: color-mix(in srgb, var(--text) 6%, transparent);
		}

		.rail:not(.collapsed) .nav-label {
			font-size: var(--t-body-size);
			font-weight: 500;
			line-height: 1;
			letter-spacing: 0;
		}

		/* Active = the single sanctioned accent, three ways at once: the
		   --accent-muted pill (inherited from base .active) + --accent-bright
		   icon/label (inherited) + this 2px left-edge marker. */
		.rail:not(.collapsed) .nav-row.active::before {
			content: '';
			position: absolute;
			left: 0;
			top: 8px;
			bottom: 8px;
			width: 2px;
			border-radius: 0 2px 2px 0;
			background: var(--accent-bright);
		}

		.rail:not(.collapsed) .foot {
			align-items: stretch;
			gap: 3px;
		}

		.rail:not(.collapsed) .sync-cluster {
			justify-content: flex-start;
			gap: 10px;
			padding: 6px 12px 8px;
			margin-bottom: 2px;
		}

		.rail:not(.collapsed) .sync-line {
			display: block;
			font-size: var(--t-label-size);
			font-weight: 500;
			color: var(--text-secondary);
			white-space: nowrap;
		}

		.rail:not(.collapsed) .notif-row {
			justify-content: flex-start;
			gap: 10px;
			height: 40px;
			padding: 0 12px;
			margin-bottom: 0;
			border-radius: 9px;
			transition: background 120ms var(--ease);
		}

		.rail:not(.collapsed) .notif-row:hover {
			background: color-mix(in srgb, var(--text) 6%, transparent);
		}

		.rail:not(.collapsed) .foot-label {
			display: block;
			font-size: var(--t-body-size);
			font-weight: 500;
			color: var(--text-secondary);
		}

		.rail:not(.collapsed) .menu-wrap {
			align-self: stretch;
		}

		.rail:not(.collapsed) .account {
			width: 100%;
			gap: 10px;
			height: 44px;
			padding: 0 12px;
			border-radius: 9px;
			transition: background 120ms var(--ease);
		}

		.rail:not(.collapsed) .account:hover {
			background: color-mix(in srgb, var(--text) 6%, transparent);
		}

		.rail:not(.collapsed) .account-name {
			display: block;
			flex: 1;
			min-width: 0;
			text-align: left;
			font-size: var(--t-body-size);
			font-weight: 500;
			color: var(--text);
		}

		.rail:not(.collapsed) .account-chev {
			display: flex;
			align-items: center;
			color: var(--text-muted);
			flex-shrink: 0;
		}

		/* Collapse chevron is available at the desktop tier in BOTH states, so it
		   is gated on the breakpoint only — never on .collapsed — otherwise a
		   collapsed sidebar would have no way back. */
		.collapse-toggle {
			display: flex;
			align-items: center;
			justify-content: center;
			width: 28px;
			height: 28px;
			margin-top: 6px;
			border: none;
			background: transparent;
			color: var(--text-muted);
			border-radius: 8px;
			cursor: pointer;
			transition:
				color 120ms var(--ease),
				background 120ms var(--ease);
		}

		.collapse-toggle:hover {
			color: var(--text-secondary);
			background: color-mix(in srgb, var(--text) 6%, transparent);
		}

		.rail:not(.collapsed) .collapse-toggle {
			align-self: flex-end;
			margin-right: 2px;
		}
	}

	@media (min-width: 1600px) {
		.rail:not(.collapsed) {
			width: var(--sidebar-w-wide);
		}
	}

	@media (max-width: 900px) {
		.rail {
			display: none;
		}
	}
</style>
