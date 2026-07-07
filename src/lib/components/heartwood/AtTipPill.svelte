<script lang="ts">
	/**
	 * AtTipPill — the compact node-status pill: a 14–16px EpochDial plus
	 * `at tip · 956,237`. Two-tone text (words muted, number brighter),
	 * translucent pill on a hairline border.
	 *
	 * Mobile drops the words and keeps the number: pass `label=""`.
	 * `pulseKey` passes straight through to the dial's once-per-block sweep.
	 */
	import EpochDial from './EpochDial.svelte';

	type DialState = 'at-tip' | 'syncing' | 'behind';

	let {
		height,
		state = 'at-tip',
		progress = 0,
		pulseKey = undefined,
		dialSize = 15,
		label = 'at tip'
	}: {
		/** Current tip height, rendered with thousands separators. */
		height: number;
		state?: DialState;
		/** 0–1 forming-ring progress, forwarded to the dial. */
		progress?: number;
		/** Change to replay the once-per-block sweep. */
		pulseKey?: unknown;
		/** Dial px size — 14–16 per spec. */
		dialSize?: number;
		/** Words before the number; empty string drops them (mobile). */
		label?: string;
	} = $props();
</script>

<span class="at-tip-pill">
	<EpochDial {state} {progress} size={dialSize} {pulseKey} />
	{#if label}
		<span class="words">{label} ·</span>
	{/if}
	<span class="num">{height.toLocaleString('en-US')}</span>
</span>

<style>
	.at-tip-pill {
		display: inline-flex;
		align-items: center;
		gap: 7px;
		padding: 5px 12px 5px 9px;
		background: rgba(255, 255, 255, 0.025);
		border: 1px solid var(--hairline);
		border-radius: var(--radius-status-pill);
		font-family: var(--font-ui);
		font-size: 11.5px;
		font-weight: 500;
		line-height: 1.4;
		white-space: nowrap;
	}

	.words {
		color: var(--text-muted);
	}

	.num {
		/* Spec literal #CFC3B8 ("number" tone) — sits between --text-secondary
		   and --text-rows; no token exists for it. */
		color: #cfc3b8;
		font-variant-numeric: tabular-nums;
	}
</style>
