<script lang="ts">
	import { enhance } from '$app/forms';
	import Logo from '$lib/components/Logo.svelte';
	import Icon from '$lib/components/Icon.svelte';

	let { data, form } = $props();

	// Initial value only, by design: after a failed submit the user's typed
	// email survives via bind:value; on first paint we seed from the server.
	// svelte-ignore state_referenced_locally
	let email = $state(form?.email ?? data.currentEmail);
	let password = $state('');
	let confirm = $state('');
	let submitting = $state(false);

	const ready = $derived(
		email.trim().length > 0 &&
			password.length >= data.minPasswordLength &&
			confirm.length >= data.minPasswordLength
	);
</script>

<svelte:head>
	<title>Secure your account — Cairn</title>
</svelte:head>

<div class="screen">
	<div class="card sheet">
		<div class="sheet-head">
			<Logo size={22} wordmark />
			<span class="badge badge-accent">First-run setup</span>
		</div>

		<h1 class="title">Make this account yours</h1>
		<p class="lede">
			You signed in with the password that came with the install. That password stays visible on
			your device's setup screen, so it can't stay your password. Choose your own, and add your
			email so reminders and confirmations have somewhere to reach you.
		</p>

		<form method="POST" action="?/complete" use:enhance={() => {
			submitting = true;
			return async ({ update }) => {
				submitting = false;
				await update();
			};
		}}>
			{#if form?.error}
				<div class="form-error" role="alert">{form.error}</div>
			{/if}

			<div class="field">
				<label class="label" for="email">Your email</label>
				<input
					class="input"
					id="email"
					type="email"
					name="email"
					bind:value={email}
					placeholder="you@example.com"
					autocomplete="email"
					required
				/>
				<span class="field-hint">Used for backup reminders and account alerts — nothing else.</span>
			</div>

			<div class="field">
				<label class="label" for="password">New password</label>
				<input
					class="input"
					id="password"
					type="password"
					name="password"
					bind:value={password}
					autocomplete="new-password"
					minlength={data.minPasswordLength}
					required
				/>
				<span class="field-hint">At least {data.minPasswordLength} characters.</span>
			</div>

			<div class="field">
				<label class="label" for="confirm">Confirm new password</label>
				<input
					class="input"
					id="confirm"
					type="password"
					name="confirm"
					bind:value={confirm}
					autocomplete="new-password"
					minlength={data.minPasswordLength}
					required
				/>
			</div>

			<button class="btn btn-primary continue" disabled={!ready || submitting}>
				{#if submitting}<span class="spinner"></span>{/if}
				Save and continue
				<Icon name="arrow-right" size={15} />
			</button>
		</form>
	</div>
</div>

<style>
	.screen {
		min-height: 100vh;
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 40px 20px;
		background: radial-gradient(120% 80% at 50% -10%, rgba(232, 147, 90, 0.08), transparent 60%);
	}
	.sheet {
		width: 100%;
		max-width: 460px;
		padding: 32px;
		display: flex;
		flex-direction: column;
		gap: 18px;
	}
	.sheet-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
	}
	.title {
		font-family: var(--font-serif);
		font-size: 26px;
		font-weight: 560;
		letter-spacing: -0.01em;
	}
	.lede {
		font-size: 14px;
		line-height: 1.6;
		color: var(--text-secondary);
		margin-top: -8px;
	}
	form {
		display: flex;
		flex-direction: column;
		gap: 16px;
	}
	.field-hint {
		font-size: 12px;
		color: var(--text-secondary);
	}
	.continue {
		align-self: flex-end;
	}
</style>
