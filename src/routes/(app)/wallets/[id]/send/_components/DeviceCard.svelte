<script lang="ts">
	import Icon from '$lib/components/Icon.svelte';

	// A disabled "coming soon" signing-method tile. These make the extensibility
	// seam visible: the hardware-wallet epic replaces each with a live,
	// device-specific card that plugs into the same Sign sub-stepper.
	let { name, hint }: { name: string; hint: string } = $props();
</script>

<div class="card card-pad device-card" aria-disabled="true">
	<div class="device-head">
		<span class="device-icon"><Icon name="server" size={18} /></span>
		<div class="grow">
			<h3 class="device-title">{name}</h3>
			<p class="device-hint">{hint}</p>
		</div>
		<span class="badge badge-neutral">Coming soon</span>
	</div>
</div>

<style>
	.device-card {
		opacity: 0.6;
		cursor: not-allowed;
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
		border-radius: var(--radius-control);
		background: var(--surface-elevated);
		color: var(--text-muted);
	}

	.device-title {
		font-size: 14px;
		font-weight: 600;
		color: var(--text-secondary);
	}

	.device-hint {
		font-size: 12px;
		color: var(--text-muted);
		margin-top: 1px;
	}
</style>
