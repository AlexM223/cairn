<script lang="ts">
	// The transaction-detail block-context section (docs/TX-BLOCK-CONTEXT-DESIGN.md
	// §5): a confirmation badge, the 1–3 block context row, and a plain-language
	// summary. Progressive-enhancement aware — it renders honestly at every tier and
	// shows a connecting state (not an error) when no backend answered.
	import { invalidate } from '$app/navigation';
	import Icon from '$lib/components/Icon.svelte';
	import BurialRings from '$lib/components/heartwood/BurialRings.svelte';
	import MiniBlock from '$lib/components/heartwood/MiniBlock.svelte';
	import { summaryLine, confirmationBadge } from '$lib/components/heartwood/blockContext';
	import type { BlockContext } from '$lib/types';

	let {
		ctx,
		isAdmin = false
	}: {
		/** null ⇒ still streaming (parent hasn't resolved the block context yet). */
		ctx: BlockContext | null;
		isAdmin?: boolean;
	} = $props();

	const badge = $derived(ctx ? confirmationBadge(ctx) : null);
	const summary = $derived(ctx ? summaryLine(ctx) : '');
	const confirmations = $derived(ctx?.confirmed ? (ctx.confirmations ?? 0) : 0);

	// Center the current block in the scroll rail on mount / when the context lands.
	let rail = $state<HTMLDivElement | null>(null);
	let currentEl = $state<HTMLElement | null>(null);
	$effect(() => {
		// re-run when the neighbours change (new tx / tier upgrade)
		void ctx?.neighbors.length;
		if (rail && currentEl) {
			currentEl.scrollIntoView({ block: 'nearest', inline: 'center' });
		}
	});

	let retrying = $state(false);
	async function retry() {
		retrying = true;
		try {
			await invalidate('cairn:tx');
		} finally {
			retrying = false;
		}
	}
</script>

{#if ctx === null}
	<!-- Streaming: the block context is an extra round-trip, painted after first paint
	     like the other supplementary tx details. A slim skeleton keeps layout stable. -->
	<section class="block-context loading" aria-hidden="true">
		<span class="skeleton badge-skel"></span>
		<div class="rail-skel">
			<span class="skeleton block-skel"></span>
			<span class="skeleton block-skel"></span>
			<span class="skeleton block-skel"></span>
		</div>
	</section>
{:else if ctx.richness === 'none'}
	<!-- NEITHER backend answered — a transient reachability issue, not missing Core.
	     Honest connecting state + retry; deliberately NO "connect Core" nag here. -->
	<section class="block-context connecting" role="status" aria-live="polite">
		<span class="spinner" aria-hidden="true"></span>
		<div class="connecting-text">
			<span class="connecting-title">Connecting to your node…</span>
			<span class="connecting-sub">Couldn't reach your node just now to place this transaction in its block.</span>
		</div>
		<button type="button" class="btn btn-secondary btn-sm" onclick={retry} disabled={retrying}>
			<Icon name="refresh" size={13} /> Retry
		</button>
	</section>
{:else}
	<section class="block-context">
		<!-- Confirmation badge + on-brand burial glyph -->
		<div class="badge-row">
			<BurialRings {confirmations} direction={ctx.confirmed ? 'in' : 'out'} size={26} />
			{#if badge}
				<span class="conf-badge" class:sealed={badge.tone === 'sealed'} class:partial={badge.tone === 'partial'} class:unconfirmed={badge.tone === 'unconfirmed'}>
					{#if badge.tone === 'sealed'}<Icon name="check" size={12} />{/if}
					{badge.label}
				</span>
			{/if}
		</div>

		<!-- Three-block context row (omitted for a still-in-mempool tx) -->
		{#if ctx.confirmed && ctx.neighbors.length > 0}
			<div class="rail" bind:this={rail}>
				{#each ctx.neighbors as n (n.height)}
					{#if n.isCurrent}
						<div bind:this={currentEl} class="rail-cell">
							<MiniBlock
								neighbor={n}
								position={ctx.position}
								positionTotal={ctx.positionTotal}
								positionEstimated={ctx.positionEstimated}
								richness={ctx.richness}
								coinbase={ctx.position === 0}
							/>
						</div>
					{:else}
						<div class="rail-cell">
							<MiniBlock neighbor={n} richness={ctx.richness} />
						</div>
					{/if}
				{/each}
			</div>
		{/if}

		<!-- Plain-language summary -->
		<p class="summary">{summary}</p>

		<!-- Quiet, admin-only Core hint at the basic tier. A perfectly good Electrum-only
		     deploy must NOT feel broken, so non-admins never see this and it's a whisper,
		     not a notice (docs/TX-BLOCK-CONTEXT-DESIGN.md §6). -->
		{#if ctx.richness === 'basic' && ctx.confirmed && isAdmin && !ctx.coreConfigured}
			<p class="core-hint">
				<Icon name="info" size={12} />
				Block sizes and exact block contents need a Bitcoin Core node — configure it in admin settings.
			</p>
		{/if}
	</section>
{/if}

<style>
	.block-context {
		display: flex;
		flex-direction: column;
		gap: 14px;
		padding: 18px 0;
		border-bottom: 1px solid var(--hairline);
	}

	.badge-row {
		display: flex;
		align-items: center;
		gap: 10px;
	}

	.conf-badge {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		padding: 3px 11px;
		border-radius: var(--radius-status-pill);
		font-size: 12.5px;
		font-weight: 600;
		border: 1px solid transparent;
	}

	.conf-badge.sealed {
		color: var(--sage);
		background: color-mix(in srgb, var(--sage) 13%, transparent);
		border-color: var(--success-border);
	}

	.conf-badge.partial {
		color: var(--text-secondary);
		background: var(--bg-input);
		border-color: var(--hairline);
	}

	.conf-badge.unconfirmed {
		color: var(--attention);
		background: var(--attention-muted);
		border-color: color-mix(in srgb, var(--attention) 40%, transparent);
	}

	.conf-badge :global(svg) {
		color: currentColor;
	}

	/* Horizontal rail: never breaks the page on narrow screens; snaps to blocks. */
	.rail {
		display: flex;
		gap: 12px;
		overflow-x: auto;
		padding: 4px 2px 8px;
		scroll-snap-type: x proximity;
		-webkit-overflow-scrolling: touch;
	}

	.rail-cell {
		display: flex;
	}

	.summary {
		margin: 0;
		font-size: 13.5px;
		line-height: 1.55;
		color: var(--text-rows);
	}

	.core-hint {
		display: flex;
		align-items: flex-start;
		gap: 6px;
		margin: 0;
		font-size: 12px;
		line-height: 1.5;
		color: var(--text-muted);
	}

	.core-hint :global(svg) {
		flex-shrink: 0;
		margin-top: 2px;
		color: var(--text-faint);
	}

	/* ---- connecting (richness: none) ---- */
	.connecting {
		display: flex;
		align-items: center;
		gap: 12px;
		padding: 18px 0;
		border-bottom: 1px solid var(--hairline);
	}

	.connecting-text {
		display: flex;
		flex-direction: column;
		gap: 2px;
		min-width: 0;
		margin-right: auto;
	}

	.connecting-title {
		font-size: 13.5px;
		font-weight: 550;
		color: var(--text-rows);
	}

	.connecting-sub {
		font-size: 12px;
		color: var(--text-muted);
	}

	/* ---- streaming skeleton ---- */
	.loading {
		gap: 12px;
	}

	.skeleton {
		display: block;
		background: var(--bg-input);
		border-radius: var(--radius-badge);
		animation: hwPulse 1.6s ease-in-out infinite;
	}

	.badge-skel {
		width: 140px;
		height: 26px;
		border-radius: var(--radius-status-pill);
	}

	.rail-skel {
		display: flex;
		gap: 12px;
	}

	.block-skel {
		width: 60px;
		height: 82px;
	}

	@keyframes hwSpin {
		to {
			transform: rotate(360deg);
		}
	}

	@media (max-width: 900px) {
		.rail {
			scroll-snap-type: x mandatory;
		}
	}
</style>
