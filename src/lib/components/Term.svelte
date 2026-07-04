<script lang="ts">
	import type { Snippet } from 'svelte';

	// An inline technical term with a plain-language explanation. The dotted
	// underline signals "this is explainable"; hover or keyboard focus reveals it.
	let { tip, children }: { tip: string; children: Snippet } = $props();
</script>

<!-- A button is the honest element here: keyboard users focus it to reveal
     the explanation, matching the hover affordance for pointer users. -->
<button type="button" class="term">
	{@render children()}
	<span class="tip" role="tooltip">{tip}</span>
</button>

<style>
	.term {
		position: relative;
		background: none;
		border: none;
		padding: 0;
		margin: 0;
		font: inherit;
		color: inherit;
		letter-spacing: inherit;
		text-transform: inherit;
		text-decoration: underline dotted var(--text-muted) 1px;
		text-underline-offset: 3px;
		cursor: help;
		outline: none;
	}

	.term:hover,
	.term:focus-visible {
		text-decoration-color: var(--accent);
	}

	.tip {
		position: absolute;
		bottom: calc(100% + 8px);
		left: 50%;
		transform: translateX(-50%);
		width: max-content;
		max-width: 280px;
		background: var(--surface-elevated);
		border: 1px solid var(--border);
		border-radius: var(--radius-control);
		box-shadow: 0 6px 24px rgba(0, 0, 0, 0.4);
		color: var(--text);
		font-size: 12.5px;
		font-weight: 400;
		font-family: var(--font-ui);
		font-variant-numeric: normal;
		line-height: 1.5;
		letter-spacing: normal;
		text-transform: none;
		text-align: left;
		white-space: normal;
		padding: 8px 11px;
		opacity: 0;
		visibility: hidden;
		transition:
			opacity 120ms var(--ease),
			visibility 120ms;
		z-index: 30;
		pointer-events: none;
	}

	.term:hover .tip,
	.term:focus-visible .tip,
	.term:focus .tip {
		opacity: 1;
		visibility: visible;
	}
</style>
