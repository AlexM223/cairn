<script lang="ts">
	/**
	 * FeeRate — the one owner of the "raw rate + plain time" fee pattern
	 * (UX-REDESIGN-SPEC.md §2.5, cairn-gt05.4): the raw sat/vB rate stays on the
	 * surface, Term-glossed, with a plain-language confirmation time beside it
	 * when one can honestly be derived — e.g. "~1 sat/vB · ≈ next block".
	 *
	 * The plain time only renders forward-looking (given `estimates` or an
	 * explicit `time`); historical rates (a mined block's median, a confirmed
	 * tx) render as the glossed rate alone. Inherits font/color from context;
	 * call sites may restyle the `.fr-num` / `.fr-unit` / `.fr-plain` parts.
	 */
	import Term from './Term.svelte';
	import { SAT_VB_TIP } from '$lib/termGlosses';
	import { feeRatePlainTime, feeRateParts, type FeeEstimates } from './feeRate';

	let {
		rate = null,
		range = null,
		estimates = null,
		time = undefined,
		approx = false
	}: {
		/** Fee rate in sat/vB. */
		rate?: number | null;
		/** A min–max span instead of a single rate (e.g. a block's fee range). */
		range?: [number, number] | null;
		/** Current estimate tiers — derives the plain time when `time` isn't given. */
		estimates?: FeeEstimates | null;
		/** Explicit plain-time override; pass null to force rate-only. */
		time?: string | null;
		/** Prefix the rate with "~". */
		approx?: boolean;
	} = $props();

	const parts = $derived(feeRateParts(rate, range));
	const plainTime = $derived(
		time !== undefined ? time : range != null ? null : feeRatePlainTime(rate, estimates)
	);
</script>

{#if parts === null}
	<span class="feerate">—</span>
{:else}
	<span class="feerate"
		><Term tip={SAT_VB_TIP}
			><span class="fr-num tabular">{approx ? '~' : ''}{parts.num}</span>
			<span class="fr-unit">{parts.unit}</span></Term
		>{#if plainTime}<span class="fr-plain"> · {plainTime}</span>{/if}</span
	>
{/if}

<style>
	/* Everything inherits from context by default; parts exist to be restyled
	   via :global(.fr-*) where a surface splits number and unit visually. */
	.feerate {
		font: inherit;
		color: inherit;
	}
</style>
