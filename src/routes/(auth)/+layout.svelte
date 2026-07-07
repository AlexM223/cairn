<script lang="ts">
	import { onMount } from 'svelte';
	import Logo from '$lib/components/Logo.svelte';
	import { maybeRedirectToSecure } from '$lib/secureRedirect';

	let { data, children } = $props();

	// Auto-hop returning users to the secure address before sign-in
	// (cairn-6uff) — the probe only succeeds once they've accepted the cert,
	// so first-timers keep the plain-HTTP login untouched.
	onMount(() => {
		void maybeRedirectToSecure(data.httpsPort ?? null);
	});
</script>

<div class="auth-page">
	<div class="auth-card fade-in">
		<div class="auth-brand">
			<Logo size={34} />
			<span class="auth-wordmark">Cairn</span>
			<span class="auth-tagline">Your bitcoin. Your rules.</span>
		</div>
		{@render children()}
		<div class="auth-foot">
			<a href="/terms">Terms</a>
		</div>
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

	.auth-foot {
		margin-top: 22px;
		text-align: center;
		font-size: 11.5px;
	}

	.auth-foot a {
		color: var(--text-muted);
	}

	.auth-foot a:hover {
		color: var(--accent);
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
