<script lang="ts">
	import { onMount } from 'svelte';
	import GroveField from '$lib/components/heartwood/GroveField.svelte';
	import HeartwoodMark from '$lib/components/heartwood/HeartwoodMark.svelte';
	import { maybeRedirectToSecure } from '$lib/secureRedirect';

	let { data, children } = $props();

	// The probe below can take up to 2.5s to resolve — plenty of time for
	// someone to have already started filling in a form (signup, especially)
	// by the time it succeeds. win.location.replace() would then tear the
	// page down mid-interaction with no error, silently orphaning whatever
	// they were doing (a submit already in flight, or one about to be — a
	// "dead button" with no visible cause, cairn-hmi4). Track interaction
	// locally and veto the hop through a wrapped `location` object rather
	// than touching the shared probe in secureRedirect.ts — its `win` param
	// is already an injectable seam for exactly this (see its test file's
	// fake storage), so this is a local, additive guard: once the user has
	// touched a field, a same-origin hop must never preempt what they're doing.
	let interacted = false;
	function markInteracted() {
		interacted = true;
	}

	// Auto-hop returning users to the secure address before sign-in
	// (cairn-6uff) — the probe only succeeds once they've accepted the cert,
	// so first-timers keep the plain-HTTP login untouched.
	onMount(() => {
		const guardedLocation = {
			get hostname() {
				return window.location.hostname;
			},
			get pathname() {
				return window.location.pathname;
			},
			get search() {
				return window.location.search;
			},
			get hash() {
				return window.location.hash;
			},
			replace(url: string) {
				// Re-check at the moment of navigation, not just at mount time —
				// interaction may start any time during the up-to-2.5s probe.
				if (!interacted) window.location.replace(url);
			}
		} as Location;
		void maybeRedirectToSecure(data.httpsPort ?? null, {
			location: guardedLocation,
			isSecureContext: window.isSecureContext,
			sessionStorage: window.sessionStorage
		});
	});
</script>

<div class="auth-page">
	<GroveField volume="grove" />
	<div class="auth-col fade-in" oninput={markInteracted} onfocusin={markInteracted}>
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
