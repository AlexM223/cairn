<script lang="ts">
	// The multi-horizon balance delta — DESIGN-MANIFESTO.md's "Notification &
	// delta-display rules" (MUST): never a naked single point-delta; 1d / 30d /
	// 1yr / all-time render together so a down window can't dominate the
	// emotional read. Percent leads ("+8%"); absolute sats sit one layer down
	// (a native title tooltip — quiet, not a second visible line). Only growth
	// gets --sage; flat/down/unknown are all the same neutral muted text —
	// "down is neutral, never red" is literal here, not just "not red."
	//
	// Pure rows come from `$lib/horizonDelta` (buildHorizonRows) — this
	// component only formats and lays them out, identically for Home
	// (server-computed, cross-wallet) and wallet-detail (client-derived from
	// that one wallet's own tx history).
	import { formatSats } from '$lib/format';
	import type { HorizonRow } from '$lib/horizonDelta';

	let { rows }: { rows: HorizonRow[] } = $props();

	function formatPct(pct: number): string {
		if (pct === 0) return '0%';
		const sign = pct > 0 ? '+' : '−';
		const abs = Math.abs(pct);
		const digits = abs < 0.1 ? '<0.1' : abs.toFixed(1);
		return `${sign}${digits}%`;
	}

	function formatSatsSigned(sats: number): string {
		if (sats === 0) return '0 sats';
		const sign = sats > 0 ? '+' : '−';
		return `${sign}${formatSats(Math.abs(sats))} sats`;
	}

	// Primary readout: percent when we have a meaningful baseline, otherwise
	// the absolute sats change (never both stacked — the sats figure moves to
	// the title tooltip whenever percent is shown, per "one layer down").
	function primaryText(row: HorizonRow): string {
		if (row.sats === null) return '—';
		if (row.pct !== null) return formatPct(row.pct);
		return formatSatsSigned(row.sats);
	}

	function titleText(row: HorizonRow): string {
		if (row.sats === null) return `${row.label}: not enough history yet`;
		return `${row.label}: ${formatSatsSigned(row.sats)}`;
	}
</script>

<div class="balance-horizons" role="group" aria-label="Balance change over 1 day, 30 days, 1 year, and all time">
	{#each rows as row (row.key)}
		<div class="horizon" title={titleText(row)}>
			<span class="horizon-label">{row.label}</span>
			<span class="horizon-value tabular" class:up={row.dir === 'up'}>{primaryText(row)}</span>
		</div>
	{/each}
</div>

<style>
	/* Quiet, non-competing set — never a lone delta (MUST). Hairline-free, just
	   four muted stats in a row beneath the hero. */
	.balance-horizons {
		display: flex;
		gap: 22px;
		flex-wrap: wrap;
	}

	.horizon {
		display: flex;
		flex-direction: column;
		gap: 2px;
	}

	.horizon-label {
		font-size: 10.5px;
		font-weight: 600;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--text-faint);
	}

	.horizon-value {
		font-size: 13px;
		font-weight: 500;
		/* Down/flat/unknown all share this neutral tone — "down is neutral,
		   never red" (DESIGN-MANIFESTO.md). Only growth gets a color at all. */
		color: var(--text-secondary);
	}

	.horizon-value.up {
		color: var(--sage);
	}

	@media (max-width: 900px) {
		.balance-horizons {
			gap: 16px;
		}

		.horizon-label {
			font-size: 10px;
		}

		.horizon-value {
			font-size: 12px;
		}
	}
</style>
