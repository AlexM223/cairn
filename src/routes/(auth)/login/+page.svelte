<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { signInWithPasskey, browserSupportsWebAuthn } from '$lib/passkey';

	let email = $state('');
	let password = $state('');
	let submitting = $state(false);
	let error = $state<string | null>(null);
	let passkeySupported = $state(false);

	onMount(() => {
		passkeySupported = browserSupportsWebAuthn();
	});

	function nextUrl(): string {
		const next = page.url.searchParams.get('next');
		return next && next.startsWith('/') ? next : '/';
	}

	async function signInPassword(e: SubmitEvent) {
		e.preventDefault();
		error = null;
		if (!email.trim() || !password) {
			error = 'Enter your email and password.';
			return;
		}
		submitting = true;
		try {
			const res = await fetch('/api/auth/login/password', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ email: email.trim(), password })
			});
			const body = await res.json().catch(() => null);
			if (!res.ok) throw new Error(body?.error || 'Could not sign in.');
			await goto(nextUrl(), { invalidateAll: true });
		} catch (err) {
			error = err instanceof Error ? err.message : 'Could not sign in.';
		} finally {
			submitting = false;
		}
	}

	async function signInPasskey() {
		error = null;
		if (!email.trim()) {
			error = 'Enter your email, then use your passkey.';
			return;
		}
		submitting = true;
		try {
			await signInWithPasskey(email.trim());
			await goto(nextUrl(), { invalidateAll: true });
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

<form class="stack" onsubmit={signInPassword}>
	{#if error}
		<div class="form-error" role="alert">{error}</div>
	{/if}

	<div class="field">
		<label class="label" for="email">Email</label>
		<input
			class="input"
			id="email"
			name="email"
			type="email"
			autocomplete="email"
			required
			bind:value={email}
		/>
	</div>

	<div class="field">
		<label class="label" for="password">Password</label>
		<input
			class="input"
			id="password"
			name="password"
			type="password"
			autocomplete="current-password"
			required
			bind:value={password}
		/>
	</div>

	<button class="btn btn-primary" disabled={submitting}>
		{#if submitting}<span class="spinner"></span>{/if}
		Sign in
	</button>

	{#if passkeySupported}
		<div class="divider"><span>or</span></div>
		<button type="button" class="btn btn-secondary" onclick={signInPasskey} disabled={submitting}>
			Sign in with a passkey
		</button>
	{/if}

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

	.divider {
		display: flex;
		align-items: center;
		gap: 10px;
		color: var(--text-muted);
		font-size: 12px;
		margin: 2px 0;
	}

	.divider::before,
	.divider::after {
		content: '';
		flex: 1;
		height: 1px;
		background: var(--border-subtle);
	}

	.alt {
		text-align: center;
		font-size: 13px;
		color: var(--text-muted);
	}
</style>
