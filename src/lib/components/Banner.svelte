<script lang="ts">
	// The one shared feedback banner (cairn-ivae.5): success / error / info /
	// warning variants with consistent styling, replacing the hand-rolled
	// `<div class="form-error">` / `<div class="saved-note">` per-page divs.
	//
	// Use it inline for persistent conditions or errors that carry recovery
	// actions (pass them via the `actions` snippet, rendered under the message);
	// for transient action feedback, fire `toast.*()` instead — <Toasts /> hosts
	// this same component in a fixed overlay.
	import type { Snippet } from 'svelte';
	import Icon from './Icon.svelte';

	let {
		variant = 'info',
		ondismiss,
		children,
		actions
	}: {
		variant?: 'success' | 'error' | 'info' | 'warning';
		/** When provided, renders a dismiss (x) button that calls this. */
		ondismiss?: () => void;
		children: Snippet;
		/** Optional recovery/follow-up actions rendered under the message. */
		actions?: Snippet;
	} = $props();

	const ICONS = {
		success: 'check',
		error: 'alert-triangle',
		warning: 'alert-triangle',
		info: 'info'
	} as const;
</script>

<div class="banner {variant}" role={variant === 'error' ? 'alert' : 'status'} aria-live="polite">
	<span class="banner-icon"><Icon name={ICONS[variant]} size={15} /></span>
	<div class="banner-body">
		<div class="banner-message">{@render children()}</div>
		{#if actions}
			<div class="banner-actions">{@render actions()}</div>
		{/if}
	</div>
	{#if ondismiss}
		<button type="button" class="banner-dismiss" aria-label="Dismiss" onclick={ondismiss}>
			<Icon name="x" size={13} />
		</button>
	{/if}
</div>

<style>
	.banner {
		display: flex;
		align-items: flex-start;
		gap: 9px;
		font-size: 13px;
		line-height: 1.5;
		padding: 9px 12px;
		border-radius: var(--radius-control);
		border: 1px solid;
	}

	.banner-icon {
		display: flex;
		flex-shrink: 0;
		margin-top: 2px;
	}

	.banner-body {
		flex: 1;
		min-width: 0;
	}

	.banner-actions {
		display: flex;
		gap: 8px;
		flex-wrap: wrap;
		margin-top: 8px;
	}

	.banner-dismiss {
		display: flex;
		align-items: center;
		justify-content: center;
		flex-shrink: 0;
		width: 22px;
		height: 22px;
		margin: -2px -4px -2px 0;
		padding: 0;
		border: none;
		border-radius: var(--radius-chip);
		background: transparent;
		color: inherit;
		opacity: 0.65;
		cursor: pointer;
	}

	.banner-dismiss:hover {
		opacity: 1;
	}

	.success {
		color: var(--success);
		background: var(--success-muted);
		border-color: rgba(107, 191, 107, 0.3);
	}

	.error {
		color: var(--error);
		background: var(--error-muted);
		border-color: var(--error-border);
	}

	.warning {
		color: var(--warning);
		background: var(--warning-muted);
		border-color: var(--warning-border);
	}

	.info {
		color: var(--text-secondary);
		background: var(--surface-elevated);
		border-color: var(--border-subtle);
	}
</style>
