<script lang="ts">
	/**
	 * EyebrowBreadcrumb — the one tracked-caps line above every hero:
	 * `WALLETS / COLD STORAGE · 2-OF-3`.
	 *
	 * Path segments join with "/" in --eyebrow-path; the optional `current`
	 * descriptor is appended after "·" in the brighter --eyebrow tone.
	 */
	import Term from '$lib/components/Term.svelte';

	let {
		path,
		current = undefined,
		tip = undefined
	}: {
		/** Path segments, joined with " / ". */
		path: string[];
		/** Final descriptor, appended as " · CURRENT" in the brighter tone. */
		current?: string;
		/** Gloss tooltip for the last path segment, when it's jargon that needs a plain-language explainer (cairn-s7rpg). */
		tip?: string;
	} = $props();
</script>

<div class="eyebrow-crumb">
	{#each path as seg, i (i)}
		{#if i > 0}<span class="sep">&nbsp;/&nbsp;</span>{/if}<span class="seg"
			>{#if tip && i === path.length - 1}<Term {tip}>{seg}</Term>{:else}{seg}{/if}</span
		>
	{/each}
	{#if current}<span class="sep">&nbsp;·&nbsp;</span><span class="current">{current}</span>{/if}
</div>

<style>
	.eyebrow-crumb {
		font-family: var(--font-ui);
		font-size: 11px;
		font-weight: 600;
		letter-spacing: 0.22em;
		text-transform: uppercase;
		line-height: 1.4;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		color: var(--eyebrow-path);
	}

	.seg,
	.sep {
		color: var(--eyebrow-path);
	}

	.current {
		color: var(--eyebrow);
	}
</style>
