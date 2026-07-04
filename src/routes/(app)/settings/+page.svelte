<script lang="ts">
	import { enhance } from '$app/forms';
	import { page } from '$app/state';

	let { form } = $props();

	const user = $derived(page.data.user);
	let savingProfile = $state(false);
	let savingPassword = $state(false);
</script>

<svelte:head>
	<title>Settings — Cairn</title>
</svelte:head>

<h1 class="page-title" style="margin-bottom: 24px">Settings</h1>

<div class="stack settings fade-in">
	<section class="card card-pad section">
		<span class="card-title">Profile</span>
		<form
			method="POST"
			action="?/profile"
			class="stack inner"
			use:enhance={() => {
				savingProfile = true;
				return async ({ update }) => {
					savingProfile = false;
					await update({ reset: false });
				};
			}}
		>
			{#if form?.profileError}
				<div class="form-error" role="alert">{form.profileError}</div>
			{:else if form?.profileSaved}
				<div class="saved-note" role="status">Profile updated.</div>
			{/if}

			<div class="field">
				<label class="label" for="displayName">Display name</label>
				<input class="input" id="displayName" name="displayName" required value={user.displayName} />
			</div>
			<div class="field">
				<label class="label" for="email">Email</label>
				<input class="input" id="email" name="email" type="email" required value={user.email} />
			</div>
			<div class="actions">
				<button class="btn btn-primary" disabled={savingProfile}>
					{#if savingProfile}<span class="spinner"></span>{/if}
					Save profile
				</button>
			</div>
		</form>
	</section>

	<section class="card card-pad section">
		<span class="card-title">Password</span>
		<form
			method="POST"
			action="?/password"
			class="stack inner"
			use:enhance={() => {
				savingPassword = true;
				return async ({ update }) => {
					savingPassword = false;
					await update();
				};
			}}
		>
			{#if form?.passwordError}
				<div class="form-error" role="alert">{form.passwordError}</div>
			{:else if form?.passwordSaved}
				<div class="saved-note" role="status">Password changed. Other sessions were signed out.</div>
			{/if}

			<div class="field">
				<label class="label" for="currentPassword">Current password</label>
				<input
					class="input"
					id="currentPassword"
					name="currentPassword"
					type="password"
					autocomplete="current-password"
					required
				/>
			</div>
			<div class="two-col">
				<div class="field">
					<label class="label" for="newPassword">New password</label>
					<input
						class="input"
						id="newPassword"
						name="newPassword"
						type="password"
						autocomplete="new-password"
						minlength="8"
						required
					/>
				</div>
				<div class="field">
					<label class="label" for="confirmPassword">Confirm new password</label>
					<input
						class="input"
						id="confirmPassword"
						name="confirmPassword"
						type="password"
						autocomplete="new-password"
						minlength="8"
						required
					/>
				</div>
			</div>
			<div class="actions">
				<button class="btn btn-primary" disabled={savingPassword}>
					{#if savingPassword}<span class="spinner"></span>{/if}
					Change password
				</button>
			</div>
		</form>
	</section>

	<section class="card card-pad section">
		<span class="card-title">Appearance</span>
		<div class="field" style="max-width: 240px">
			<label class="label" for="theme">Theme</label>
			<select class="select input" id="theme" disabled title="Light theme is on the roadmap">
				<option selected>The Forge (dark)</option>
				<option>Light — coming soon</option>
			</select>
			<span class="hint">One theme for now. The toggle lights up in a future release.</span>
		</div>
	</section>
</div>

<style>
	.settings {
		gap: 14px;
		max-width: 640px;
	}

	.section {
		display: flex;
		flex-direction: column;
		gap: 14px;
	}

	.inner {
		gap: 14px;
	}

	.two-col {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 12px;
	}

	@media (max-width: 560px) {
		.two-col {
			grid-template-columns: 1fr;
		}
	}

	.actions {
		display: flex;
		justify-content: flex-end;
	}

	.saved-note {
		font-size: 13px;
		color: var(--success);
		background: var(--success-muted);
		border: 1px solid rgba(107, 191, 107, 0.3);
		border-radius: var(--radius-control);
		padding: 9px 12px;
	}
</style>
