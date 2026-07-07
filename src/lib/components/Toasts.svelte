<script lang="ts">
	// Fixed-overlay host for the toast queue (cairn-ivae.5). Mount once per page
	// (bottom of the markup is fine — placement is fixed regardless), then fire
	// messages from anywhere with toast.success/error/info/warning. Renders the
	// shared <Banner> visuals so inline banners and toasts look identical.
	import { fly } from 'svelte/transition';
	import Banner from './Banner.svelte';
	import { toast } from './toast.svelte';
</script>

{#if toast.items.length > 0}
	<div class="toasts">
		{#each toast.items as t (t.id)}
			<div class="toast" transition:fly={{ y: 10, duration: 160 }}>
				<Banner variant={t.variant} ondismiss={() => toast.dismiss(t.id)}>{t.message}</Banner>
			</div>
		{/each}
	</div>
{/if}

<style>
	.toasts {
		position: fixed;
		bottom: 18px;
		right: 18px;
		z-index: 200;
		display: flex;
		flex-direction: column;
		gap: 8px;
		width: min(380px, calc(100vw - 36px));
		pointer-events: none;
	}

	.toast {
		pointer-events: auto;
		/* Toasts float over page content — give the shared banner a solid card
		   backdrop so muted (translucent) variant backgrounds stay readable. */
		background: var(--surface);
		border-radius: var(--radius-control);
		box-shadow: 0 6px 24px rgba(0, 0, 0, 0.35);
	}
</style>
