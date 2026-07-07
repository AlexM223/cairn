<script lang="ts">
	import Icon from '$lib/components/Icon.svelte';

	// A signing-method tile in the Sign step's method grid. Two modes:
	//
	// - Selectable (disabled=false + onselect): a clickable tile that expands
	//   into the method's full signer card when chosen.
	// - Disabled (default): either a "coming soon" seam (no live card built yet,
	//   e.g. Trezor) or an unavailable method — per the DeviceMethod contract,
	//   methods this browser can't run render disabled with a short `reason`.
	let {
		name,
		hint,
		icon = 'server',
		disabled = true,
		badge = 'Coming soon',
		reason,
		onselect
	}: {
		name: string;
		hint: string;
		icon?: string;
		disabled?: boolean;
		/** Badge shown in the disabled state, e.g. "Coming soon" / "Unavailable". */
		badge?: string;
		/** Why the method can't run here — replaces `hint` when disabled. */
		reason?: string;
		onselect?: () => void;
	} = $props();
</script>

{#if !disabled && onselect}
	<button type="button" class="device-card selectable" onclick={onselect}>
		<div class="device-head">
			<span class="device-icon live"><Icon name={icon} size={18} /></span>
			<div class="grow">
				<h3 class="device-title">{name}</h3>
				<p class="device-hint">{hint}</p>
			</div>
			<span class="select-cue"><Icon name="chevron-right" size={16} /></span>
		</div>
	</button>
{:else}
	<div class="device-card" aria-disabled="true">
		<div class="device-head">
			<span class="device-icon"><Icon name={icon} size={18} /></span>
			<div class="grow">
				<h3 class="device-title">{name}</h3>
				<p class="device-hint">{reason ?? hint}</p>
			</div>
			<span class="badge badge-neutral">{badge}</span>
		</div>
	</div>
{/if}

<style>
	/* Hairline row — same grammar as the sibling .method-active tile in the
	   Sign step's method-grid, not a boxed card. */
	.device-card {
		display: block;
		width: 100%;
		padding: 14px 0;
		border-bottom: 1px solid var(--hairline);
		background: transparent;
		border-left: none;
		border-right: none;
		border-top: none;
		cursor: not-allowed;
	}

	.device-card.selectable {
		cursor: pointer;
		text-align: left;
		font-family: var(--font-ui);
		transition: background-color 120ms var(--ease);
	}

	.device-card.selectable:hover {
		background: rgba(255, 255, 255, 0.018);
	}

	.device-head {
		display: flex;
		align-items: center;
		gap: 12px;
	}

	.device-icon {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 36px;
		height: 36px;
		flex-shrink: 0;
		border-radius: var(--radius-icon-btn);
		background: var(--surface-elevated);
		/* Decorative (the title names the method) — faint is allowed here. */
		color: var(--text-faint);
	}

	.device-icon.live {
		background: var(--accent-muted);
		color: var(--accent);
	}

	.grow {
		flex: 1;
		min-width: 0;
	}

	.device-title {
		font-size: 14px;
		font-weight: 600;
		color: var(--text-secondary);
	}

	.selectable .device-title {
		color: var(--text);
	}

	.device-hint {
		font-size: 12px;
		color: var(--text-muted);
		margin-top: 1px;
	}

	.select-cue {
		display: flex;
		color: var(--text-muted);
		flex-shrink: 0;
	}

	.selectable:hover .select-cue {
		color: var(--accent);
	}
</style>
