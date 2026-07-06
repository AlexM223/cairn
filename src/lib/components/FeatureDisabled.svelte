<script lang="ts">
	import Icon from './Icon.svelte';

	// A consistent affordance for a feature an admin has turned off. Renders a
	// greyed, non-interactive chip that STATES the feature is disabled (both as
	// visible text and a tooltip), so a flag-gated control reads as "turned off"
	// rather than silently vanishing — a user can't otherwise tell "disabled"
	// from "never existed" (cairn-8dup). Pass the flag's own userMessage.
	let {
		message,
		block = false
	}: {
		/** The reason shown to the user, e.g. the flag's userMessage. */
		message: string;
		/** Fill the row (for standalone captions) rather than sitting inline. */
		block?: boolean;
	} = $props();
</script>

<span class="feature-disabled" class:block title={message}>
	<Icon name="lock" size={13} />
	<span>{message}</span>
</span>

<style>
	.feature-disabled {
		display: inline-flex;
		align-items: center;
		gap: 7px;
		padding: 7px 11px;
		border: 1px dashed var(--border);
		border-radius: var(--radius-control);
		background: var(--surface-elevated);
		color: var(--text-muted);
		font-size: 12.5px;
		line-height: 1.4;
		cursor: not-allowed;
	}

	.feature-disabled.block {
		display: flex;
	}
</style>
