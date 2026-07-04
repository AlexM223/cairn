<script lang="ts">
	import Logo from '$lib/components/Logo.svelte';

	let { children } = $props();
</script>

<div class="auth-page">
	<div class="auth-card fade-in">
		<div class="auth-brand">
			<Logo size={34} />
			<span class="auth-wordmark">Cairn</span>
			<span class="auth-tagline">Your bitcoin. Your rules.</span>
		</div>
		{@render children()}
	</div>
</div>

<style>
	.auth-page {
		min-height: 100vh;
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 24px;
	}

	.auth-card {
		width: 100%;
		max-width: 380px;
		background: var(--surface);
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-card);
		padding: 36px 32px 32px;
	}

	.auth-brand {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 6px;
		margin-bottom: 28px;
	}

	.auth-wordmark {
		font-family: var(--font-serif);
		font-size: 26px;
		font-weight: 600;
		letter-spacing: -0.01em;
		margin-top: 6px;
	}

	.auth-tagline {
		font-size: 12.5px;
		color: var(--text-muted);
	}
</style>
