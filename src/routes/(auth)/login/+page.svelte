<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { signInWithPasskey, browserSupportsWebAuthn } from '$lib/passkey';
	import { resolveNextUrl } from './nextUrl';
	import Banner from '$lib/components/Banner.svelte';

	let { data } = $props();

	let email = $state('');
	let password = $state('');
	let submitting = $state(false);
	let error = $state<string | null>(null);
	let passkeySupported = $state(false);
	// SAFE mitigation for desktop passkey failures: the button only renders
	// when the ceremony can succeed on THIS origin — secure context AND this
	// origin matches the server's expected WebAuthn origin (data.passkeyOriginOk,
	// see $lib/server/passkeyOrigin.ts). When a secure context hides it for
	// the origin-mismatch reason specifically (not the ordinary insecure-HTTP
	// case, which is unaffected and unchanged), show a hint pointing at the
	// address where passkeys do work.
	let showPasskeyOriginHint = $state(false);

	onMount(() => {
		const supported = browserSupportsWebAuthn();
		passkeySupported = supported && data.passkeyOriginOk;
		showPasskeyOriginHint = supported && !data.passkeyOriginOk;
	});

	function nextUrl(): string {
		return resolveNextUrl(page.url.searchParams.get('next'));
	}

	// The v0.1.1 Umbrel bug's failure shape, kept from ever being silent again
	// (cairn-az83): login succeeds server-side, but the browser drops the session
	// cookie (e.g. a Secure cookie over plain HTTP), so the next request is
	// unauthenticated and this page just reloads with no feedback. Before
	// navigating, probe an authenticated endpoint; a definite 401 means the
	// cookie didn't stick — say so instead of looping.
	const COOKIE_ERROR =
		'Login succeeded, but your browser did not keep the session cookie — the ' +
		'connection may not support secure cookies. Contact your administrator ' +
		'(on a plain-HTTP server, ORIGIN or PROTOCOL_HEADER needs to be set).';

	async function sessionStuck(): Promise<boolean> {
		try {
			const res = await fetch('/api/auth/me', { cache: 'no-store' });
			return res.status !== 401;
		} catch {
			// A network blip can't tell us anything — give the login the benefit
			// of the doubt rather than blocking a session the server accepted.
			return true;
		}
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
			if (!(await sessionStuck())) throw new Error(COOKIE_ERROR);
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
			if (!(await sessionStuck())) throw new Error(COOKIE_ERROR);
			await goto(nextUrl(), { invalidateAll: true });
		} catch (err) {
			error = err instanceof Error ? err.message : 'Could not sign in.';
		} finally {
			submitting = false;
		}
	}
</script>

<svelte:head>
	<title>Sign in — Heartwood</title>
</svelte:head>

<form class="stack" onsubmit={signInPassword}>
	{#if error}
		<Banner variant="error">{error}</Banner>
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
		<button type="button" class="btn btn-secondary" onclick={signInPasskey} disabled={submitting}>
			Sign in with a passkey
		</button>
	{:else if showPasskeyOriginHint}
		<p class="hint origin-hint">
			Passkeys are available at {data.passkeyExpectedOrigin} — on this address, sign in with your
			email and password.
		</p>
	{/if}

	<p class="alt"><a href="/recover">Lost your passkey?</a></p>

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

	.alt {
		text-align: center;
		font-size: 13px;
		color: var(--text-muted);
	}

	.origin-hint {
		text-align: center;
		margin-top: 2px;
	}
</style>
