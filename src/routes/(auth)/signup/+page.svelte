<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { signUpWithPasskey, browserSupportsWebAuthn } from '$lib/passkey';

	let { data } = $props();

	let displayName = $state('');
	let email = $state('');
	let inviteCode = $state('');
	let submitting = $state(false);
	let error = $state<string | null>(null);
	let supported = $state(true);

	onMount(() => {
		supported = browserSupportsWebAuthn();
	});

	function validate(): string | null {
		if (!displayName.trim()) return 'Enter a display name.';
		if (!email.trim()) return 'Enter your email address.';
		if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) return 'Enter a valid email address.';
		if (data.needsInvite && !inviteCode.trim())
			return 'This instance requires an invite code to join.';
		return null;
	}

	async function createAccount(e: SubmitEvent) {
		e.preventDefault();
		error = validate();
		if (error) return;
		submitting = true;
		try {
			await signUpWithPasskey({
				email: email.trim(),
				displayName: displayName.trim(),
				inviteCode: inviteCode.trim() || undefined
			});
			await goto('/', { invalidateAll: true });
		} catch (err) {
			error = err instanceof Error ? err.message : 'Could not create the account.';
		} finally {
			submitting = false;
		}
	}
</script>

<svelte:head>
	<title>Create account — Cairn</title>
</svelte:head>

{#if data.closed}
	<div class="empty-state">
		<div class="empty-title">Registration is closed</div>
		<p>This instance isn't accepting new accounts right now.</p>
		<a href="/login" class="btn btn-secondary" style="margin-top: 8px">Back to sign in</a>
	</div>
{:else}
	{#if data.firstUser}
		<div class="first-user-note">
			You're setting up this instance — the first account becomes the administrator.
		</div>
	{/if}

	<form class="stack" onsubmit={createAccount}>
		{#if !supported}
			<div class="form-error" role="alert">
				This browser doesn't support passkeys. Use a recent version of Chrome, Safari, Edge or
				Firefox.
			</div>
		{:else if error}
			<div class="form-error" role="alert">{error}</div>
		{/if}

		<div class="field">
			<label class="label" for="displayName">Display name</label>
			<input
				class="input"
				id="displayName"
				name="displayName"
				autocomplete="name"
				required
				bind:value={displayName}
			/>
		</div>

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

		{#if data.needsInvite}
			<div class="field">
				<label class="label" for="inviteCode">Invite code</label>
				<input
					class="input mono"
					id="inviteCode"
					name="inviteCode"
					placeholder="CAIRN-XXXX-XXXX"
					required
					bind:value={inviteCode}
				/>
				<span class="hint">
					Invites come from whoever runs this Cairn instance — ask them for a code.
				</span>
			</div>
		{/if}

		<div class="passkey-explainer">
			<strong>You'll create a passkey next.</strong>
			A passkey is like a digital key stored on your device (or synced through iCloud / Google Password
			Manager). It's more secure than a password — it can't be phished, leaked, or guessed. Your browser
			will prompt for Touch&nbsp;ID, Face&nbsp;ID, Windows&nbsp;Hello, or a security key.
		</div>

		<button class="btn btn-primary" disabled={submitting || !supported}>
			{#if submitting}<span class="spinner"></span>{/if}
			{data.firstUser ? 'Set up Cairn with a passkey' : 'Create account with a passkey'}
		</button>

		<p class="alt">Already have an account? <a href="/login">Sign in</a></p>
	</form>
{/if}

<style>
	form {
		gap: 16px;
	}

	.first-user-note {
		font-size: 12.5px;
		color: var(--accent);
		background: var(--accent-muted);
		border-radius: var(--radius-control);
		padding: 9px 12px;
		margin-bottom: 16px;
		line-height: 1.5;
	}

	.passkey-explainer {
		font-size: 12.5px;
		color: var(--text-secondary);
		background: var(--surface-elevated);
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-control);
		padding: 11px 13px;
		line-height: 1.55;
	}

	.passkey-explainer strong {
		color: var(--text);
		display: block;
		margin-bottom: 3px;
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
</style>
