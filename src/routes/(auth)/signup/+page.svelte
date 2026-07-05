<script lang="ts">
	import { goto } from '$app/navigation';

	let { data } = $props();

	let displayName = $state('');
	let email = $state('');
	let password = $state('');
	let inviteCode = $state('');
	let submitting = $state(false);
	let error = $state<string | null>(null);

	function validate(): string | null {
		if (!displayName.trim()) return 'Enter a display name.';
		if (!email.trim()) return 'Enter your email address.';
		if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) return 'Enter a valid email address.';
		if (password.length < 8) return 'Password must be at least 8 characters.';
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
			const res = await fetch('/api/auth/register/password', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					email: email.trim(),
					displayName: displayName.trim(),
					password,
					inviteCode: inviteCode.trim() || undefined
				})
			});
			const body = await res.json().catch(() => null);
			if (!res.ok) throw new Error(body?.error || 'Could not create the account.');
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
		{#if error}
			<div class="form-error" role="alert">{error}</div>
		{/if}

		<div class="field">
			<label class="label" for="displayName">Display name</label>
			<input class="input" id="displayName" name="displayName" autocomplete="name" required bind:value={displayName} />
		</div>

		<div class="field">
			<label class="label" for="email">Email</label>
			<input class="input" id="email" name="email" type="email" autocomplete="email" required bind:value={email} />
		</div>

		<div class="field">
			<label class="label" for="password">Password</label>
			<input
				class="input"
				id="password"
				name="password"
				type="password"
				autocomplete="new-password"
				minlength="8"
				required
				bind:value={password}
			/>
			<span class="hint">At least 8 characters. You can add a passkey later in Settings.</span>
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

		<button class="btn btn-primary" disabled={submitting}>
			{#if submitting}<span class="spinner"></span>{/if}
			{data.firstUser ? 'Set up Cairn' : 'Create account'}
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
