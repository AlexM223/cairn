<script lang="ts">
	/**
	 * CoreRpcRequiredNotice — the one shared "this feature needs your own Bitcoin
	 * Core node" empty-state (cairn-zoz8.9).
	 *
	 * Cairn has no third-party HTTP explorer dependency: the RICH Explorer
	 * features (full recent-block metadata, CPFP package info, per-output
	 * spent/unspent status, mempool-blocks projection, mempool time-series) can
	 * only come from a self-hosted Bitcoin Core RPC. Public-Electrum-only installs
	 * lose those, and this component is how each RPC-gated section says so —
	 * honestly and in plain language, NEVER a silent degrade to 0/blank and NEVER
	 * a proxy to some other third party's indexer.
	 *
	 * Callers gate their own rendering on a `coreRpcConfigured` prop (sourced from
	 * `coreRpcConfigured()` in `$lib/server/settings`, passed through the route
	 * load) and drop this in when it's false. The migration beads for each feature
	 * (cairn-zoz8.10 blocks, .11 outspends, .12 CPFP, .14 mempool-blocks, .15
	 * mempool trend) wire it into their sections.
	 *
	 * Two shapes:
	 *  - full panel (default) — for a whole page section / missing data panel.
	 *  - `compact` — an inline chip for a single missing cell (e.g. one table
	 *    cell where a spent/unspent badge would go).
	 *
	 * The settings link only shows for admins (`isAdmin`); everyone else sees a
	 * softer "ask your instance operator" line — mirroring ChainHealthBanner.
	 */
	import Icon from './Icon.svelte';

	let {
		feature,
		isAdmin = false,
		compact = false
	}: {
		/**
		 * Short human label for the unavailable feature, e.g. "Block details",
		 * "CPFP fee info", "Mempool projections". Used in the notice copy — keep it
		 * a noun phrase, not a sentence.
		 */
		feature: string;
		/**
		 * Whether the viewing user is an instance admin. Admins get a direct link to
		 * the Core RPC settings section; non-admins get a "ask your operator" line
		 * since they can't act on it. Pass `locals.user?.isAdmin ?? false` from the
		 * route load.
		 */
		isAdmin?: boolean;
		/**
		 * Render the slim inline chip variant (for a single missing table cell)
		 * instead of the full centered panel (for a whole page section).
		 */
		compact?: boolean;
	} = $props();

	// One anchor, referenced from both variants. The settings-wiring bead
	// (cairn-zoz8.8) reintroduces the Core RPC subgroup on the admin settings
	// page; until it names its own anchor, link to the page generally. If/when it
	// adds an id (e.g. `#core-rpc`), append it here so the link deep-jumps.
	const SETTINGS_HREF = '/admin/settings';
</script>

{#if compact}
	<span class="core-rpc-chip" title="{feature} needs a Bitcoin Core RPC connection">
		<Icon name="server" size={12} />
		{#if isAdmin}
			<a href={SETTINGS_HREF}>Needs Bitcoin Core</a>
		{:else}
			<span>Needs Bitcoin Core</span>
		{/if}
	</span>
{:else}
	<div class="core-rpc-notice empty-state" role="status">
		<span class="notice-icon" aria-hidden="true"><Icon name="server" size={22} /></span>
		<span class="empty-title">{feature} needs a Bitcoin Core node</span>
		<p class="notice-body">
			Cairn reads this straight from your own Bitcoin Core node over its RPC connection — never
			from a third-party service. Without a node configured, there's no honest source for it, so
			it's turned off rather than guessed.
		</p>
		{#if isAdmin}
			<a class="btn btn-secondary btn-sm" href={SETTINGS_HREF}>
				<Icon name="settings" size={14} /> Configure Bitcoin Core
			</a>
		{:else}
			<span class="notice-hint">Ask your instance operator to connect a Bitcoin Core node.</span>
			<!-- Non-admins can't act on the hint above, and the tiny breadcrumb link
			     up top can be scrolled off-screen on mobile (cairn-uibo) — give them
			     an explicit way back instead of a dead end. -->
			<a class="btn btn-secondary btn-sm" href="/explorer">
				<Icon name="chevron-left" size={14} /> Back to explorer
			</a>
		{/if}
	</div>
{/if}

<style>
	/* --- full panel: reuses the global .empty-state grammar, adds an accent-
	   tinted card frame so a "needs setup" section reads as intentional rather
	   than an error or a blank. --- */
	.core-rpc-notice {
		gap: 10px;
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-card);
		background: var(--surface-elevated);
	}

	.notice-icon {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 42px;
		height: 42px;
		margin-bottom: 2px;
		border-radius: 50%;
		background: var(--accent-muted);
		color: var(--accent);
	}

	.notice-body {
		max-width: 42ch;
		margin: 0;
		font-size: 13px;
		line-height: 1.55;
		color: var(--text-muted);
	}

	.core-rpc-notice .btn {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		margin-top: 4px;
	}

	.notice-hint {
		margin-top: 2px;
		font-size: 12.5px;
		color: var(--text-secondary);
	}

	/* --- compact chip: for a single missing table cell. Mirrors
	   FeatureDisabled's dashed non-interactive chip so "unavailable" reads
	   consistently across the app. --- */
	.core-rpc-chip {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		padding: 3px 8px;
		border: 1px dashed var(--border);
		border-radius: var(--radius-chip);
		background: var(--surface-elevated);
		color: var(--text-muted);
		font-size: 11.5px;
		line-height: 1.4;
		white-space: nowrap;
	}

	.core-rpc-chip :global(svg) {
		flex-shrink: 0;
		color: var(--accent);
	}

	.core-rpc-chip a {
		color: var(--accent);
		font-weight: 500;
	}
</style>
