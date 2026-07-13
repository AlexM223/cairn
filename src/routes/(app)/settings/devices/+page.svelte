<script lang="ts">
	import { enhance } from '$app/forms';
	import { goto } from '$app/navigation';
	import { timeAgo, expiresIn } from '$lib/format';
	import Banner from '$lib/components/Banner.svelte';
	import GroveField from '$lib/components/heartwood/GroveField.svelte';
	import BackCircle from '$lib/components/heartwood/BackCircle.svelte';
	import EyebrowBreadcrumb from '$lib/components/heartwood/EyebrowBreadcrumb.svelte';

	let { data, form } = $props();

	function since(iso: string): string {
		return timeAgo(Math.floor(new Date(iso).getTime() / 1000));
	}

	// expiresAt is a FUTURE timestamp, so timeAgo/since would always read
	// "just now" (negative diff). Use the forward-looking formatter instead.
	function until(iso: string): string {
		return expiresIn(Math.floor(new Date(iso).getTime() / 1000));
	}
</script>

<svelte:head>
	<title>Devices &amp; sessions — Settings — Heartwood</title>
</svelte:head>

<div class="grove-bleed" aria-hidden="true"><GroveField volume="whisper" /></div>

<div class="hw-page hw-owns-header fade-in">
	<!-- Mobile flow header: back circle + centered eyebrow + spacer. -->
	<header class="flow-header">
		<BackCircle href="/settings" label="Back to settings" />
		<span class="flow-eyebrow">DEVICES</span>
		<span class="flow-spacer"></span>
	</header>

	<!-- Desktop eyebrow breadcrumb, linking back to Settings. Navigates via
	     goto(..., { replaceState: true }) rather than a plain <a> so it
	     replaces the current history entry instead of pushing a new one —
	     otherwise Back alternates between here and /settings (cairn-ojvs). -->
	<a
		class="crumb-link"
		href="/settings"
		onclick={(e) => {
			e.preventDefault();
			goto('/settings', { replaceState: true });
		}}
	>
		<EyebrowBreadcrumb path={['Settings']} current={'Devices & sessions'} />
	</a>

	<h1 class="page-title">Devices &amp; sessions</h1>
	<p class="lede">
		Where you're signed in, and the devices Heartwood remembers for new-device alerts. Revoking a
		session signs that device out immediately; forgetting a device just means its next sign-in
		triggers a "new device" alert again.
	</p>

	{#if form?.error}
		<Banner variant="error">{form.error}</Banner>
	{/if}

	<section class="hw-section">
		<h2 class="section-title">Active sessions</h2>
		{#if data.sessions.length === 0}
			<p class="hint">No active sessions.</p>
		{:else}
			<ul class="hw-rows">
				{#each data.sessions as s (s.id)}
					<li class="hw-row">
						<div class="row-body">
							<div class="row-title">
								{s.device}
								{#if s.current}<span class="badge badge-success">this device</span>{/if}
							</div>
							<div class="row-sub">Signed in {since(s.createdAt)} · expires {until(s.expiresAt)}</div>
						</div>
						{#if !s.current}
							<form method="POST" action="?/revokeSession" use:enhance>
								<input type="hidden" name="id" value={s.id} />
								<button class="btn btn-ghost btn-sm">Revoke</button>
							</form>
						{/if}
					</li>
				{/each}
			</ul>
		{/if}
	</section>

	<section class="hw-section">
		<h2 class="section-title">Remembered devices</h2>
		{#if data.devices.length === 0}
			<p class="hint">No remembered devices yet — they appear after you sign in.</p>
		{:else}
			<ul class="hw-rows">
				{#each data.devices as d (d.fingerprint)}
					<li class="hw-row">
						<div class="row-body">
							<div class="row-title">{d.device}</div>
							<div class="row-sub">First seen {since(d.firstSeen)} · last seen {since(d.lastSeen)}</div>
						</div>
						<form method="POST" action="?/forgetDevice" use:enhance>
							<input type="hidden" name="fingerprint" value={d.fingerprint} />
							<button class="btn btn-ghost btn-sm">Forget</button>
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
		max-width: 560px;
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
		display: flex;
		align-items: center;
		gap: 8px;
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
