<script lang="ts">
	/**
	 * NodeTrustChip — the "Verified by your node" provenance indicator placed
	 * near every Explorer hero (cairn-6efi.3, Explorer-redesign Wave 2 T-B).
	 *
	 * This component is a pure PRESENTER: it renders the single trust claim that
	 * the server already derived in nodeTrust.ts (TRUST_SPECS) and never
	 * assembles a trust string of its own. The honesty matrix is enforced
	 * upstream — the chip only chooses an icon/colour from `trust.tone` and shows
	 * `trust.label` / `trust.headline` verbatim. `verified`, `ownInfrastructure`,
	 * `source` are booleans/enums off the server object, so no copy here can
	 * over-claim.
	 *
	 * The popover (node-health details) opens on click, closes on outside-click
	 * or Escape. Motion is a short CSS fade honoring prefers-reduced-motion.
	 */
	import Icon from '$lib/components/Icon.svelte';
	import { timeAgo, formatNumber } from '$lib/format';
	import type { NodeTrust, NodeTrustTone, NodeSyncPhase } from '$lib/types';

	let { trust }: { trust: NodeTrust | null } = $props();

	let open = $state(false);
	let rootEl = $state<HTMLElement | null>(null);

	function toggle() {
		open = !open;
	}
	function close() {
		open = false;
	}
	function onKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape' && open) {
			close();
			(rootEl?.querySelector('.chip') as HTMLButtonElement | null)?.focus();
		}
	}
	function onWindowClick(e: MouseEvent) {
		if (open && rootEl && !rootEl.contains(e.target as Node)) close();
	}

	// Icon + accessible tone word per trust tone. Icon names are the vetted set
	// in Icon.svelte; tone drives colour via the data-tone attribute below.
	const ICON: Record<NodeTrustTone, string> = {
		verified: 'shield',
		own: 'server',
		public: 'activity',
		warning: 'alert-triangle',
		idle: 'info'
	};

	const PHASE_LABEL: Record<NodeSyncPhase, string> = {
		connecting: 'Connecting…',
		history: 'Reading chain history',
		scanning: 'Scanning addresses',
		synced: 'Following the tip',
		unreachable: 'Not reachable'
	};

	const icon = $derived(trust ? ICON[trust.tone] : 'info');
	const phaseText = $derived(trust?.syncPhase ? PHASE_LABEL[trust.syncPhase] : null);
	const lastSeen = $derived(
		trust?.lastSyncedAt ? timeAgo(Math.floor(trust.lastSyncedAt / 1000)) : null
	);
</script>

<svelte:window onkeydown={onKeydown} onclick={onWindowClick} />

{#if trust}
	<div class="node-trust" bind:this={rootEl}>
		<button
			type="button"
			class="chip"
			data-tone={trust.tone}
			aria-expanded={open}
			aria-haspopup="dialog"
			onclick={toggle}
			title={trust.headline}
		>
			<Icon name={icon} size={13} />
			<span class="chip-label">{trust.label}</span>
			<Icon name="chevron-down" size={12} />
		</button>

		{#if open}
			<div class="popover" role="dialog" aria-label="Node connection details" data-tone={trust.tone}>
				<div class="pop-head">
					<Icon name={icon} size={15} />
					<span class="pop-headline">{trust.headline}</span>
				</div>

				<dl class="pop-rows">
					{#if phaseText}
						<div class="pop-row">
							<dt>Status</dt>
							<dd>{phaseText}</dd>
						</div>
					{/if}
					{#if trust.tipHeight !== null}
						<div class="pop-row">
							<dt>Last block seen</dt>
							<dd class="mono">#{formatNumber(trust.tipHeight)}</dd>
						</div>
					{/if}
					{#if lastSeen}
						<div class="pop-row">
							<dt>Last updated</dt>
							<dd>{lastSeen}</dd>
						</div>
					{/if}
					{#if trust.server}
						<div class="pop-row">
							<dt>{trust.source === 'core' ? 'Node' : 'Server'}</dt>
							<dd class="mono server">{trust.server}</dd>
						</div>
					{/if}
					{#if trust.provisionedBy}
						<div class="pop-row">
							<dt>Set up by</dt>
							<dd>{trust.provisionedBy}</dd>
						</div>
					{/if}
				</dl>

				<!-- Rendered ONLY when the data provably came from the operator's own
				     infrastructure — the honesty matrix's ownInfrastructure gate. -->
				{#if trust.ownInfrastructure}
					<p class="pop-provenance own">
						<Icon name="check" size={13} />
						<span>Nothing here came from a third party.</span>
					</p>
				{:else if trust.source === 'public'}
					<p class="pop-provenance shared">
						This explorer is reading the shared public server. Connect your own node in
						settings to verify every figure yourself.
					</p>
				{:else}
					<p class="pop-provenance shared">
						Connect a Bitcoin node or Electrum server in settings so the explorer reads your
						own copy of the chain.
					</p>
				{/if}
			</div>
		{/if}
	</div>
{/if}

<style>
	.node-trust {
		position: relative;
		display: inline-flex;
	}

	.chip {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		padding: 4px 10px;
		border-radius: var(--radius-status-pill);
		border: 1px solid var(--border-subtle);
		background: var(--bg-input);
		color: var(--text-secondary);
		font-size: 0.78rem;
		font-weight: 500;
		line-height: 1.2;
		cursor: pointer;
		transition:
			border-color 0.15s ease,
			color 0.15s ease;
	}
	.chip:hover {
		border-color: var(--border);
		color: var(--text);
	}
	.chip-label {
		white-space: nowrap;
	}

	/* Tone accents — colour the icon + a hairline, never the whole pill, so the
	   chip stays quiet. Sage = your own verified node, copper-ish = own server,
	   attention = degraded, muted = public/idle. */
	.chip[data-tone='verified'] {
		border-color: var(--success-border);
		color: var(--text);
	}
	.chip[data-tone='verified'] :global(svg:first-child) {
		color: var(--sage);
	}
	.chip[data-tone='own'] :global(svg:first-child) {
		color: var(--accent);
	}
	.chip[data-tone='public'] :global(svg:first-child) {
		color: var(--text-muted);
	}
	.chip[data-tone='warning'] {
		border-color: var(--warning-border);
	}
	.chip[data-tone='warning'] :global(svg:first-child) {
		color: var(--attention);
	}
	.chip[data-tone='idle'] :global(svg:first-child) {
		color: var(--text-muted);
	}

	.popover {
		position: absolute;
		top: calc(100% + 8px);
		left: 0;
		z-index: 40;
		width: min(20rem, 88vw);
		padding: 14px;
		border-radius: var(--radius-card);
		border: 1px solid var(--border);
		background: var(--surface-elevated);
		box-shadow: 0 12px 34px rgba(0, 0, 0, 0.42);
		animation: pop-in 0.14s ease;
	}
	@keyframes pop-in {
		from {
			opacity: 0;
			transform: translateY(-3px);
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.popover {
			animation: none;
		}
	}

	.pop-head {
		display: flex;
		align-items: flex-start;
		gap: 8px;
		margin-bottom: 12px;
	}
	.pop-head :global(svg) {
		flex-shrink: 0;
		margin-top: 1px;
	}
	.popover[data-tone='verified'] .pop-head :global(svg) {
		color: var(--sage);
	}
	.popover[data-tone='own'] .pop-head :global(svg) {
		color: var(--accent);
	}
	.popover[data-tone='warning'] .pop-head :global(svg) {
		color: var(--attention);
	}
	.popover[data-tone='public'] .pop-head :global(svg),
	.popover[data-tone='idle'] .pop-head :global(svg) {
		color: var(--text-muted);
	}
	.pop-headline {
		font-size: 0.86rem;
		font-weight: 600;
		color: var(--text-hero);
		line-height: 1.35;
	}

	.pop-rows {
		display: flex;
		flex-direction: column;
		gap: 7px;
		margin: 0 0 12px;
	}
	.pop-row {
		display: flex;
		justify-content: space-between;
		gap: 12px;
		font-size: 0.8rem;
	}
	.pop-row dt {
		color: var(--text-muted);
	}
	.pop-row dd {
		margin: 0;
		color: var(--text-rows);
		text-align: right;
	}
	.pop-row dd.server {
		font-size: 0.75rem;
		word-break: break-all;
	}
	.mono {
		font-variant-numeric: tabular-nums;
		font-family: var(--font-mono, ui-monospace, monospace);
	}

	.pop-provenance {
		display: flex;
		align-items: flex-start;
		gap: 7px;
		margin: 0;
		padding-top: 10px;
		border-top: 1px solid var(--border-subtle);
		font-size: 0.78rem;
		line-height: 1.4;
	}
	.pop-provenance :global(svg) {
		flex-shrink: 0;
		margin-top: 1px;
	}
	.pop-provenance.own {
		color: var(--sage);
	}
	.pop-provenance.shared {
		color: var(--text-secondary);
	}
</style>
