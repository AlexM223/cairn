<script lang="ts">
	// Explorer block-detail celebration (bead cairn-r1hca): this instance's own
	// pool found the block being viewed. Growth-green treatment per
	// DESIGN-MANIFESTO.md §2/§5 — the confirmed-state chip+panel language
	// (`--sage` / `--sage-muted`, same family as the "Yours in this ring"
	// panel) elevated one notch for a genuine one-time celebration, never a
	// loud green field and never confetti. One-shot calm entrance only (the
	// shared `.fade-in` keyframe, already neutralized under
	// prefers-reduced-motion) — nothing here re-animates on re-render.
	import Icon from '$lib/components/Icon.svelte';
	import Amount from '$lib/components/Amount.svelte';
	import { timeAgo } from '$lib/format';

	let {
		isYou,
		finderName,
		rewardSats,
		foundAt,
		walletId
	}: {
		/** True only when the viewer themself is the finder (server-scoped). */
		isYou: boolean;
		finderName: string;
		rewardSats: number;
		/** ISO timestamp string. */
		foundAt: string;
		/** The finder's payout wallet — non-null only when `isYou`. */
		walletId: number | null;
	} = $props();

	const foundAgo = $derived(timeAgo(Math.floor(new Date(foundAt).getTime() / 1000)));
</script>

<section class="pool-found fade-in" aria-label="This block was found by this pool">
	<span class="pool-found-icon" aria-hidden="true"><Icon name="check" size={16} /></span>
	<div class="pool-found-body">
		<span class="pool-found-headline">
			{isYou ? 'You found this block' : 'Found by this pool'}
		</span>
		<span class="pool-found-line">
			{#if isYou}
				Your miner earned <Amount sats={rewardSats} size="inline" direction="in" />
			{:else}
				<strong>{finderName}</strong> earned <Amount sats={rewardSats} size="inline" direction="in"
				/>
			{/if}
			<span class="pool-found-dot" aria-hidden="true">·</span>
			{foundAgo}
		</span>
		{#if isYou && walletId !== null}
			<a href="/wallets/{walletId}" class="pool-found-link">
				View payout wallet <Icon name="arrow-right" size={12} />
			</a>
		{/if}
	</div>
</section>

<style>
	.pool-found {
		margin-top: 28px;
		display: flex;
		align-items: flex-start;
		gap: 14px;
		padding: 18px 20px;
		background: var(--sage-muted);
		border: 1px solid var(--success-border);
		border-radius: var(--radius-panel, var(--radius-badge));
	}

	.pool-found-icon {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 30px;
		height: 30px;
		flex-shrink: 0;
		border-radius: 50%;
		background: var(--sage);
		color: var(--on-accent, var(--bg));
	}

	.pool-found-body {
		display: flex;
		flex-direction: column;
		gap: 5px;
		min-width: 0;
	}

	.pool-found-headline {
		font-size: 16px;
		font-weight: 600;
		color: var(--sage);
		letter-spacing: -0.005em;
	}

	.pool-found-line {
		font-size: 13.5px;
		color: var(--text-secondary);
		display: flex;
		align-items: baseline;
		flex-wrap: wrap;
		gap: 6px;
	}

	.pool-found-line strong {
		color: var(--text);
		font-weight: 600;
	}

	.pool-found-dot {
		color: var(--text-faint);
	}

	.pool-found-link {
		margin-top: 3px;
		display: inline-flex;
		align-items: center;
		gap: 5px;
		font-size: 12.5px;
		font-weight: 500;
		color: var(--accent);
		width: fit-content;
	}

	.pool-found-link:hover {
		color: var(--accent-hover);
	}

	@media (max-width: 900px) {
		.pool-found {
			margin-top: 22px;
			padding: 15px 16px;
		}

		.pool-found-headline {
			font-size: 14.5px;
		}

		.pool-found-line {
			font-size: 12.5px;
		}
	}
</style>
