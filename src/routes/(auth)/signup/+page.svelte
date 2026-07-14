<script lang="ts">
	import { goto } from '$app/navigation';
	import Banner from '$lib/components/Banner.svelte';
	import { validateSignup } from './validate';

	let { data } = $props();

	let displayName = $state('');
	let email = $state('');
	let password = $state('');
	// svelte-ignore state_referenced_locally — seeds the editable field from
	// the ?invite= link (cairn-h3x6); the user can still edit it afterwards.
	let inviteCode = $state(data.invite);
	let submitting = $state(false);
	let error = $state<string | null>(null);

	function validate(): string | null {
		return validateSignup({
			displayName,
			email,
			password,
			needsInvite: data.needsInvite,
			inviteCode
		});
	}

	async function createAccount(e: SubmitEvent) {
		e.preventDefault();
		// Guard against re-entrant submits (Enter key + button click, or a double
		// Enter). Without this, a second invocation resets `error` to null while the
		// first request is still in flight, so a 400's error banner never appears.
		if (submitting) return;
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
	<title>Create account — Heartwood</title>
</svelte:head>

{#if data.closed}
	<div class="empty-state">
		<div class="empty-title">Registration is closed</div>
		<p>This instance isn't accepting new accounts right now.</p>
		<a href="/login" class="btn btn-secondary" style="margin-top: 8px">Back to sign in</a>
	</div>
{:else}
	{#if data.firstUser}
		<Banner variant="info">
			You're setting up this instance — the first account becomes the administrator.
		</Banner>
	{/if}

	<!--
		novalidate hands all validation to validate() below so every empty/invalid
		field surfaces a styled message in the form-error banner. Without it the
		browser's native `required` check short-circuits submit on the first empty
		field (e.g. a blank invite code) showing only a focus outline and no text
		(cairn-1qv7). The `required` attributes are kept as accessibility hints.
	-->
	<form class="stack" onsubmit={createAccount} novalidate>
		{#if error}
			<Banner variant="error">{error}</Banner>
		{/if}

		<div class="field">
			<label class="label" for="displayName">Display name</label>
			<input class="input" id="displayName" name="displayName" autocomplete="name" maxlength="60" required bind:value={displayName} />
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
					Invites come from whoever runs this Heartwood instance — ask them for a code.
				</span>
			</div>
		{/if}

		<button class="btn btn-primary" disabled={submitting}>
			{#if submitting}<span class="spinner"></span>{/if}
			{data.firstUser ? 'Set up Heartwood' : 'Create account'}
		</button>

		<p class="alt">Already have an account? <a href="/login">Sign in</a></p>
	</form>
{/if}

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
</style>
