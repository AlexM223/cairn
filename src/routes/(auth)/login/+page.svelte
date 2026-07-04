<script lang="ts">
	import { enhance } from '$app/forms';

	let { form } = $props();
	let submitting = $state(false);
</script>

<svelte:head>
	<title>Sign in — Cairn</title>
</svelte:head>

<form
	method="POST"
	class="stack"
	use:enhance={() => {
		submitting = true;
		return async ({ update }) => {
			submitting = false;
			await update();
		};
	}}
>
	{#if form?.error}
		<div class="form-error" role="alert">{form.error}</div>
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
			autocomplete="current-password"
			required
		/>
	</div>

	<button class="btn btn-primary" disabled={submitting}>
		{#if submitting}<span class="spinner"></span>{/if}
		Sign in
	</button>

	<p class="alt">
		No account? <a href="/signup">Create one</a>
	</p>
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
</style>
