<script lang="ts">
	import { onMount } from 'svelte';
	import GroveField from '$lib/components/heartwood/GroveField.svelte';
	import HeartwoodMark from '$lib/components/heartwood/HeartwoodMark.svelte';
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
	<GroveField volume="grove" />
	<div class="auth-col fade-in">
		<div class="auth-brand">
			<HeartwoodMark size={60} tone="copper" detail="full" />
			<span class="auth-wordmark">Heartwood</span>
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
		position: relative;
		min-height: 100vh;
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 40px 24px;
	}

	/* No card — the "hairlines, not boxes" grammar. A centered ~360 column
	   sitting directly on the grove field (spec screens 5i / 8j). */
	.auth-col {
		position: relative;
		z-index: 1;
		width: 100%;
		max-width: 360px;
	}

	.auth-brand {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 4px;
		margin-bottom: 30px;
	}

	.auth-wordmark {
		font-family: var(--font-serif);
		font-size: 27px;
		font-weight: 600;
		letter-spacing: -0.01em;
		color: var(--text-hero);
		margin-top: 14px;
	}

	.auth-tagline {
		font-size: 12.5px;
		color: var(--text-muted);
	}

	/* ---- Pill hardware for the forms rendered inside this shell ----
	   The pages use the shared .input/.btn classes; the auth shell upgrades
	   them to the spec's 52px radius-26 pills without each page repeating it. */
	.auth-col :global(input.input),
	.auth-col :global(select.select) {
		height: 52px;
		padding: 0 20px;
		border-radius: var(--radius-pill);
		font-size: 14.5px;
	}

	/* Multi-line secrets (the recovery phrase) can't be a 52px pill — soften
	   the corners instead and keep comfortable padding. */
	.auth-col :global(textarea.input) {
		border-radius: 18px;
		padding: 14px 18px;
	}

	.auth-col :global(.btn) {
		min-height: 52px;
		padding: 12px 24px;
		font-size: 15px;
		font-weight: 600;
	}

	.auth-col :global(.label) {
		padding-left: 20px;
	}

	.auth-col :global(.form-error) {
		border-radius: 18px;
		padding: 11px 18px;
	}

	.auth-foot {
		margin-top: 30px;
		text-align: center;
		font-size: 11.5px;
	}

	.auth-foot a {
		color: var(--text-muted);
	}

	.auth-foot a:hover {
		color: var(--accent);
	}

	@media (max-width: 900px) {
		.auth-page {
			padding: 32px 20px;
		}

		.auth-col :global(.btn) {
			min-height: 50px;
		}
	}
</style>
