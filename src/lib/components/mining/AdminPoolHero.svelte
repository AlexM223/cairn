<script lang="ts">
	/**
	 * AdminPoolHero — the pool's current hashrate as THE hero number
	 * (DESIGN-MANIFESTO.md §1/§3: Fraunces, `--text` ivory, tabular-nums — never
	 * accent-colored, never green; hashrate isn't a growth/health signal, it's
	 * a plain fact, so it gets the same treatment as a balance: found by size,
	 * not hue). connectedUsers/connectedWorkers are the node's public
	 * "bragging metrics" secondary pair underneath.
	 */
	import { formatHashrate } from '$lib/shared/hashrate';
	import { formatNumber } from '$lib/format';
	import type { AdminMiningPoolView } from './adminMiningView';

	let { pool }: { pool: AdminMiningPoolView } = $props();

	const parts = $derived(formatHashrate(pool.hashrateNow).split(' '));
	const heroValue = $derived(parts[0] ?? '—');
	const heroUnit = $derived(parts[1] ?? '');
</script>

<div class="pool-hero fade-in">
	<div class="hero-row">
		<span class="hero-number t-hero">{heroValue}</span>
		{#if heroUnit}<span class="hero-unit">{heroUnit}</span>{/if}
	</div>
	<span class="hero-sub">pool hashrate right now · 24h avg {formatHashrate(pool.hashrate24h)}</span>

	<div class="secondary-stats">
		<div class="sec-stat">
			<span class="sec-v tabular">{formatNumber(pool.connectedUsers)}</span>
			<span class="sec-k">connected user{pool.connectedUsers === 1 ? '' : 's'}</span>
		</div>
		<div class="sec-stat">
			<span class="sec-v tabular">{formatNumber(pool.connectedWorkers)}</span>
			<span class="sec-k">connected worker{pool.connectedWorkers === 1 ? '' : 's'}</span>
		</div>
	</div>
</div>

<style>
	.pool-hero {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	.hero-row {
		display: flex;
		align-items: baseline;
		gap: 10px;
	}

	/* .t-hero (src/app.css) already sets Fraunces / --text / tabular-nums per
	   the manifesto — the unit suffix is the only thing muted here. */
	.hero-unit {
		font-size: 22px;
		font-weight: 500;
		color: var(--text-muted);
	}

	.hero-sub {
		font-size: 13.5px;
		color: var(--text-secondary);
	}

	.secondary-stats {
		display: flex;
		gap: 32px;
		margin-top: 18px;
	}

	.sec-stat {
		display: flex;
		flex-direction: column;
		gap: 2px;
	}

	.sec-v {
		font-size: 20px;
		font-weight: 500;
		color: var(--text-rows);
	}

	.sec-k {
		font-size: 12.5px;
		color: var(--text-faint);
	}
</style>
