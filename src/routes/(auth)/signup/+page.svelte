<script lang="ts">
	import { enhance } from '$app/forms';

	let { data, form } = $props();
	let submitting = $state(false);
	let clientError = $state<string | null>(null);

	// Validation runs here (not via native bubbles) so failures render in
	// Cairn's own error style instead of the browser default tooltip.
	function validate(el: HTMLFormElement): string | null {
		const value = (name: string) =>
			(el.elements.namedItem(name) as HTMLInputElement | null)?.value.trim() ?? '';
		if (!value('displayName')) return 'Enter a display name.';
		const email = value('email');
		if (!email) return 'Enter your email address.';
		if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return 'Enter a valid email address.';
		if ((el.elements.namedItem('password') as HTMLInputElement).value.length < 8)
			return 'Password must be at least 8 characters.';
		if (el.elements.namedItem('inviteCode') && !value('inviteCode'))
			return 'This instance requires an invite code to join.';
		return null;
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

	<form
		method="POST"
		class="stack"
		novalidate
		use:enhance={({ formElement, cancel }) => {
			clientError = validate(formElement);
			if (clientError) {
				cancel();
				return;
			}
			submitting = true;
			return async ({ update }) => {
				submitting = false;
				await update();
			};
		}}
	>
		{#if clientError}
			<div class="form-error" role="alert">{clientError}</div>
		{:else if form?.error}
			<div class="form-error" role="alert">{form.error}</div>
		{/if}

		<div class="field">
			<label class="label" for="displayName">Display name</label>
			<input
				class="input"
				id="displayName"
				name="displayName"
				autocomplete="name"
				required
				value={form?.displayName ?? ''}
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
				value={form?.email ?? ''}
			/>
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
			/>
			<span class="hint">At least 8 characters.</span>
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
					value={form?.inviteCode ?? ''}
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

		<p class="alt">
			Already have an account? <a href="/login">Sign in</a>
		</p>
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
