<script lang="ts">
	import { page } from '$app/state';
	import Logo from '$lib/components/Logo.svelte';

	const message = $derived(
		page.status === 404
			? "This path doesn't lead anywhere."
			: (page.error?.message ?? 'Something went wrong.')
	);
</script>

<svelte:head>
	<title>{page.status} — Cairn</title>
</svelte:head>

<div class="error-page">
	<div class="error-card fade-in">
		<Logo size={30} />
		<div class="status hero-number">{page.status}</div>
		<p class="message">{message}</p>
		<div class="actions">
			<a href="/" class="btn btn-primary">Back to dashboard</a>
			<a href="/explorer" class="btn btn-ghost">Open the explorer</a>
		</div>
	</div>
</div>

<style>
	.error-page {
		min-height: 100vh;
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 24px;
	}

	.error-card {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 10px;
		text-align: center;
		max-width: 360px;
	}

	.status {
		font-size: 72px;
		color: var(--accent);
		margin-top: 8px;
	}

	.message {
		color: var(--text-secondary);
		font-size: 14.5px;
		line-height: 1.6;
	}

	.actions {
		display: flex;
		gap: 10px;
		margin-top: 14px;
		flex-wrap: wrap;
		justify-content: center;
	}
</style>
