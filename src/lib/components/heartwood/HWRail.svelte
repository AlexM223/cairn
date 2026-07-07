<script lang="ts">
	// Heartwood desktop nav rail (design source: HWRail.dc.html) — the 68px
	// icon column shown at >=900px. Ships the shell only: the epoch dial at the
	// bottom is a static placeholder glyph until the Node lane (cairn-koy4.8)
	// wires live sync-height data into a proper component.
	import { page } from '$app/state';
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

	function onDocClick(e: MouseEvent) {
		if (menuOpen && menuWrap && !menuWrap.contains(e.target as Node)) menuOpen = false;
	}
	function onKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape') menuOpen = false;
	}
</script>

<svelte:window onclick={onDocClick} onkeydown={onKeydown} />

<aside class="rail">
	<a href="/" class="mark" aria-label="Home">
		<svg width="26" height="26" viewBox="0 0 100 100" aria-hidden="true">
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
	</a>

	<nav class="icons" aria-label="Main">
		{#each navItems as item (item.href)}
			<a
				href={item.href}
				class="icon-btn"
				class:active={isActive(item.href)}
				title={item.label}
				aria-label={item.label}
				aria-current={isActive(item.href) ? 'page' : undefined}
			>
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
			</a>
		{/each}
	</nav>

	<div class="spacer"></div>

	<!-- Epoch dial placeholder: static glyph from the design source. No invented
	     "synced" copy — cairn-koy4.8 replaces this with a live component. -->
	<svg class="dial" width="38" height="38" viewBox="0 0 34 34" aria-hidden="true">
		<circle cx="17" cy="17" r="5" fill="none" stroke="var(--accent)" stroke-width="1.1" opacity=".45" />
		<circle cx="17" cy="17" r="9" fill="none" stroke="var(--accent)" stroke-width="1.1" opacity=".6" />
		<circle cx="17" cy="17" r="13.5" fill="none" stroke="#2e2620" stroke-width="1.6" />
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

	<div class="notif-slot">
		<NotificationPanel />
	</div>

	<div class="menu-wrap" bind:this={menuWrap}>
		<button
			type="button"
			class="avatar"
			aria-haspopup="true"
			aria-expanded={menuOpen}
			aria-label="Account menu"
			onclick={() => (menuOpen = !menuOpen)}
		>
			{user.displayName.slice(0, 1).toUpperCase()}
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
</aside>

<style>
	.rail {
		width: 68px;
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

	.mark {
		display: flex;
		margin-bottom: 30px;
	}

	.icons {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 6px;
	}

	.icon-btn {
		width: 40px;
		height: 40px;
		border-radius: 11px;
		display: flex;
		align-items: center;
		justify-content: center;
		/* Spec rail-inactive tone — between --text-faint and --eyebrow-path;
		   decorative-weight by design, the title/aria-label carries meaning. */
		color: #7a6e63;
		background: transparent;
		transition:
			color 120ms var(--ease),
			background 120ms var(--ease);
	}

	.icon-btn:hover {
		color: var(--text-secondary);
	}

	.icon-btn.active {
		color: var(--accent-bright);
		background: rgba(232, 147, 90, 0.1);
	}

	.spacer {
		flex: 1;
	}

	.dial {
		overflow: visible;
		margin-bottom: 14px;
	}

	.dial-arc {
		filter: drop-shadow(0 0 3px rgba(232, 147, 90, 0.5));
	}

	.dial-tip {
		animation: hwPulse 2.4s ease-in-out infinite;
	}

	.notif-slot {
		margin-bottom: 10px;
	}

	.menu-wrap {
		position: relative;
	}

	.avatar {
		width: 30px;
		height: 30px;
		border: none;
		border-radius: 50%;
		background: linear-gradient(135deg, #b5673a, #e8935a);
		display: flex;
		align-items: center;
		justify-content: center;
		font: 600 12.5px var(--font-ui);
		color: var(--on-accent);
		cursor: pointer;
		padding: 0;
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
		background: rgba(255, 255, 255, 0.03);
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

	@media (max-width: 900px) {
		.rail {
			display: none;
		}
	}
</style>
