<script lang="ts">
	import { enhance } from '$app/forms';
	import { timeAgo, formatDateTime } from '$lib/format';
	import GroveField from '$lib/components/heartwood/GroveField.svelte';
	import BackCircle from '$lib/components/heartwood/BackCircle.svelte';
	import EyebrowBreadcrumb from '$lib/components/heartwood/EyebrowBreadcrumb.svelte';
	import Icon from '$lib/components/Icon.svelte';

	let { data, form } = $props();

	let name = $state('');
	let expiresDays = $state('');

	function since(iso: string): string {
		return timeAgo(Math.floor(new Date(iso).getTime() / 1000));
	}

	// The token value is shown exactly once (form.created). Selecting the field
	// on focus keeps manual copy easy even where the clipboard API is blocked
	// (plain-HTTP Umbrel deployments — cairn-w6gg).
	function selectAll(e: Event) {
		(e.currentTarget as HTMLInputElement).select();
	}
</script>

<svelte:head>
	<title>API tokens — Settings — Heartwood</title>
</svelte:head>

<div class="grove-bleed" aria-hidden="true"><GroveField volume="whisper" /></div>

<div class="hw-page hw-owns-header fade-in">
	<!-- Mobile flow header: back circle + centered eyebrow + spacer. -->
	<header class="flow-header">
		<BackCircle href="/settings" label="Back to settings" />
		<span class="flow-eyebrow">API TOKENS</span>
		<span class="flow-spacer"></span>
	</header>

	<!-- Desktop eyebrow breadcrumb, linking back to Settings. -->
	<a class="crumb-link" href="/settings">
		<EyebrowBreadcrumb path={['Settings']} current="API tokens" />
	</a>

	<h1 class="page-title">API tokens</h1>
	<p class="lede">
		Personal access tokens let scripts and tools use Heartwood's API as you — pull balances into a
		spreadsheet, trigger a backup from cron, or build your own tooling. Send one as
		<code>Authorization: Bearer &lt;token&gt;</code> on any API request. A token has the same
		access as your account, so treat it like a password and revoke any you no longer use.
	</p>

	{#if form?.error}
		<div class="form-error" role="alert">{form.error}</div>
	{/if}

	{#if form?.created}
		<div class="token-reveal" role="status">
			<div class="reveal-head">
				<Icon name="check" size={15} />
				<span>
					<strong>Token “{form.created.name}” created.</strong> Copy it now — it will never be
					shown again.
				</span>
			</div>
			<input
				class="input mono token-value"
				type="text"
				readonly
				value={form.created.token}
				onfocus={selectAll}
				onclick={selectAll}
			/>
		</div>
	{/if}

	<section class="hw-section">
		<h2 class="section-title">Create a token</h2>
		<form
			method="POST"
			action="?/create"
			class="create-form"
			use:enhance={() =>
				async ({ update }) => {
					name = '';
					await update();
				}}
		>
			<div class="field grow">
				<label class="label" for="name">Name</label>
				<input
					class="input"
					id="name"
					name="name"
					type="text"
					maxlength="64"
					placeholder="e.g. balance-spreadsheet"
					bind:value={name}
				/>
			</div>
			<div class="field">
				<label class="label" for="expires">Expires</label>
				<select class="input" id="expires" name="expiresDays" bind:value={expiresDays}>
					<option value="">Never</option>
					<option value="30">30 days</option>
					<option value="90">90 days</option>
					<option value="365">1 year</option>
				</select>
			</div>
			<button class="btn btn-primary">Create token</button>
		</form>
	</section>

	<section class="hw-section">
		<h2 class="section-title">Your tokens</h2>
		{#if data.tokens.length === 0}
			<p class="hint">No tokens yet.</p>
		{:else}
			<ul class="hw-rows">
				{#each data.tokens as t (t.id)}
					<li class="hw-row">
						<div class="row-body">
							<div class="row-title">{t.name}</div>
							<div class="row-sub">
								Created {since(t.createdAt)}
								· {t.lastUsedAt ? `last used ${since(t.lastUsedAt)}` : 'never used'}
								{#if t.expiresAt}
									· expires {formatDateTime(Math.floor(new Date(t.expiresAt).getTime() / 1000))}
								{/if}
							</div>
						</div>
						<form method="POST" action="?/revoke" use:enhance>
							<input type="hidden" name="id" value={t.id} />
							<button class="btn btn-ghost btn-sm">Revoke</button>
						</form>
					</li>
				{/each}
			</ul>
		{/if}
	</section>
</div>

<style>
	/* Grove field bleeds to the viewport behind the content column. */
	.grove-bleed {
		position: fixed;
		inset: 0;
		z-index: 0;
		pointer-events: none;
	}

	.hw-page {
		position: relative;
		z-index: 1;
		max-width: 660px;
		margin: 0 auto;
	}

	/* This page composes its own mobile flow header, so the shell's
	   bare-back-circle fallback is suppressed while it's mounted. */
	:global(body:has(.hw-owns-header) .mobile-flow-header) {
		display: none;
	}

	.flow-header {
		display: none;
	}

	.flow-eyebrow {
		font-size: 10px;
		font-weight: 600;
		letter-spacing: 0.2em;
		text-transform: uppercase;
		color: var(--eyebrow);
		text-align: center;
	}

	.crumb-link {
		display: inline-block;
		margin-bottom: 12px;
		text-decoration: none;
	}

	.crumb-link:hover :global(.seg) {
		color: var(--eyebrow);
	}

	@media (max-width: 900px) {
		.crumb-link {
			display: none;
		}

		.flow-header {
			display: flex;
			align-items: center;
			justify-content: space-between;
			gap: 10px;
			margin-bottom: 14px;
		}

		.flow-spacer {
			width: 32px;
			height: 32px;
			flex-shrink: 0;
		}
	}

	.lede {
		font-size: 13px;
		line-height: 1.6;
		color: var(--text-secondary);
		margin-top: 8px;
		max-width: 600px;
	}

	.lede code {
		font-family: var(--font-mono);
		font-size: 0.92em;
		color: var(--text);
	}

	.form-error {
		margin-top: 14px;
	}

	/* One-time token reveal — sage confirmation, input-filled value. */
	.token-reveal {
		display: flex;
		flex-direction: column;
		gap: 10px;
		margin-top: 18px;
		padding: 13px 15px;
		background: var(--sage-muted);
		border: 1px solid rgba(138, 160, 110, 0.3);
		border-radius: var(--radius-strip);
	}

	.reveal-head {
		display: flex;
		gap: 8px;
		align-items: flex-start;
		font-size: 12.5px;
		line-height: 1.55;
		color: var(--sage);
	}

	.reveal-head span {
		color: var(--text-secondary);
	}

	.reveal-head strong {
		color: var(--text);
		font-weight: 600;
	}

	.reveal-head :global(svg) {
		flex-shrink: 0;
		margin-top: 2px;
		color: var(--sage);
	}

	.token-value {
		width: 100%;
		font-size: 12.5px;
	}

	.hw-section {
		margin-top: 34px;
	}

	.section-title {
		font-size: 17px;
		font-weight: 600;
		color: var(--text);
		letter-spacing: -0.01em;
	}

	.create-form {
		display: flex;
		align-items: flex-end;
		gap: 10px;
		flex-wrap: wrap;
		margin-top: 14px;
	}

	.create-form .grow {
		flex: 1;
		min-width: 200px;
	}

	/* Hairline rows — the 5h grammar: rows, not boxes. */
	.hw-rows {
		list-style: none;
		margin: 6px 0 0;
		padding: 0;
		display: flex;
		flex-direction: column;
	}

	.hw-row {
		display: flex;
		align-items: center;
		gap: 14px;
		padding: 15px 0;
		border-bottom: 1px solid var(--hairline);
	}

	.hw-row:last-child {
		border-bottom: none;
	}

	.row-body {
		flex: 1;
		min-width: 0;
	}

	.row-title {
		font-size: 14.5px;
		font-weight: 500;
		color: var(--text-rows);
	}

	.row-sub {
		font-size: 12px;
		color: var(--text-muted);
		margin-top: 2px;
	}

	.hint {
		margin-top: 8px;
	}

	@media (max-width: 900px) {
		.hw-section {
			margin-top: 26px;
		}

		.section-title {
			font-size: 14.5px;
		}

		.hw-row {
			padding: 13px 0;
		}

		.row-title {
			font-size: 13px;
		}

		.row-sub {
			font-size: 10.5px;
		}
	}
</style>
