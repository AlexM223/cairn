<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { signInWithPasskey, browserSupportsWebAuthn } from '$lib/passkey';

	let email = $state('');
	let submitting = $state(false);
	let error = $state<string | null>(null);
	let supported = $state(true);

	onMount(() => {
		supported = browserSupportsWebAuthn();
	});

	async function signIn(e: SubmitEvent) {
		e.preventDefault();
		error = null;
		if (!email.trim()) {
			error = 'Enter your email address.';
			return;
		}
		submitting = true;
		try {
			await signInWithPasskey(email.trim());
			const next = page.url.searchParams.get('next');
			await goto(next && next.startsWith('/') ? next : '/', { invalidateAll: true });
		} catch (err) {
			error = err instanceof Error ? err.message : 'Could not sign in.';
		} finally {
			submitting = false;
		}
	}
</script>

<svelte:head>
	<title>Sign in — Cairn</title>
</svelte:head>

<form class="stack" onsubmit={signIn}>
	{#if !supported}
		<div class="form-error" role="alert">
			This browser doesn't support passkeys. Use a recent version of Chrome, Safari, Edge or
			Firefox.
		</div>
	{:else if error}
		<div class="form-error" role="alert">{error}</div>
	{/if}

	<div class="field">
		<label class="label" for="email">Email</label>
		<input
			class="input"
			id="email"
			name="email"
			type="email"
			autocomplete="email webauthn"
			required
			bind:value={email}
		/>
	</div>

	<button class="btn btn-primary" disabled={submitting || !supported}>
		{#if submitting}<span class="spinner"></span>{/if}
		Sign in with passkey
	</button>

	<p class="hint passkey-note">
		Your device will ask for Touch&nbsp;ID, Face&nbsp;ID, Windows&nbsp;Hello, or your security key —
		no password needed.
	</p>

	<p class="alt">No account? <a href="/signup">Create one</a></p>
</form>

<style>
	form {
		gap: 16px;
	}

	.btn {
		width: 100%;
		margin-top: 4px;
	}

	.passkey-note {
		text-align: center;
		line-height: 1.5;
	}

	.alt {
		text-align: center;
		font-size: 13px;
		color: var(--text-muted);
	}
</style>
