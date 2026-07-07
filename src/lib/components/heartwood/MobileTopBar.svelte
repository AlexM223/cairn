<script lang="ts">
	// Heartwood mobile top bar (<=900px, tab pages only): mark + wordmark on the
	// left; on the right an at-tip dial pill placeholder (or a search icon on
	// Explorer, per spec) and the avatar menu. Node & Settings live behind the
	// avatar menu on mobile — the tab row below never shows them.
	let {
		variant = 'dial',
		user,
		operatorName = null
	}: {
		variant?: 'dial' | 'search';
		user: { displayName: string; email: string; isAdmin: boolean };
		operatorName?: string | null;
	} = $props();

	// Heartwood mark, detail="simple" — inlined (shared HeartwoodMark component
	// is a parallel lane; consolidation is a later cleanup pass).
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

<header class="topbar">
	<a href="/" class="brand" aria-label="Home">
		<svg width="22" height="22" viewBox="0 0 100 100" aria-hidden="true">
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

	<div class="right">
		{#if variant === 'search'}
			<a href="/explorer" class="search-btn" aria-label="Search the chain">
				<svg
					width="17"
					height="17"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					stroke-width="1.6"
					stroke-linecap="round"
					aria-hidden="true"
				>
					<path d="M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zm10 2-4.3-4.3" />
				</svg>
			</a>
		{:else}
			<!-- At-tip dial pill placeholder: static glyph only, no invented sync
			     copy — the Node lane (cairn-koy4.8) wires the live height. -->
			<span class="tip-pill" aria-hidden="true">
				<svg width="16" height="16" viewBox="0 0 34 34" class="tip-dial">
					<circle cx="17" cy="17" r="13.5" fill="none" stroke="#2e2620" stroke-width="2.4" />
					<circle
						cx="17"
						cy="17"
						r="13.5"
						fill="none"
						stroke="var(--accent)"
						stroke-width="2.4"
						stroke-linecap="round"
						stroke-dasharray="27.5 57.3"
						transform="rotate(-90 17 17)"
					/>
					<circle cx="27.8" cy="10.7" r="2.6" fill="var(--accent-glow)" class="tip-dot" />
					<circle cx="17" cy="17" r="2" fill="var(--accent-core)" />
				</svg>
			</span>
		{/if}

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
					{#if user.isAdmin}
						<a href="/admin" class="menu-item" role="menuitem" onclick={() => (menuOpen = false)}>
							Node
						</a>
					{/if}
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
	</div>
</header>

<style>
	.topbar {
		display: none;
	}

	.brand {
		display: flex;
		align-items: center;
		gap: 9px;
	}

	.wordmark {
		font-family: var(--font-ui);
		font-size: 14px;
		font-weight: 600;
		letter-spacing: -0.01em;
		color: var(--text);
	}

	.right {
		display: flex;
		align-items: center;
		gap: 10px;
	}

	.search-btn {
		width: 32px;
		height: 32px;
		border-radius: var(--radius-icon-btn);
		border: 1px solid var(--border-control);
		display: flex;
		align-items: center;
		justify-content: center;
		color: var(--text-secondary);
	}

	.tip-pill {
		display: flex;
		align-items: center;
		padding: 6px 7px;
		background: rgba(255, 255, 255, 0.025);
		border: 1px solid var(--hairline);
		border-radius: var(--radius-status-pill);
	}

	.tip-dial {
		overflow: visible;
		display: block;
	}

	.tip-dot {
		animation: hwPulse 2.4s ease-in-out infinite;
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
		right: 0;
		top: calc(100% + 8px);
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
		padding: 8px 10px;
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

	.menu-signout {
		color: var(--text-muted);
	}

	.menu-signout:hover {
		color: var(--error);
		background: var(--error-muted);
	}

	@media (max-width: 900px) {
		.topbar {
			display: flex;
			align-items: center;
			justify-content: space-between;
			padding: 16px 18px;
		}
	}
</style>
