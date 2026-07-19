<script lang="ts">
	import GroveField from '$lib/components/heartwood/GroveField.svelte';
	import HeartwoodMark from '$lib/components/heartwood/HeartwoodMark.svelte';
	import Icon from '$lib/components/Icon.svelte';

	let { data } = $props();

	const p = $derived(data.preview);

	// "Alex invited you" only when we have a captain AND the headline isn't
	// already their name (instanceName unset falls back to "[captain]'s node",
	// where repeating the name directly underneath would read like a stutter).
	const showCaptainLine = $derived(
		!!p?.captainName && !!p?.instanceName && data.nodeTitle !== `${p?.captainName}'s node`
	);

	const blockLine = $derived(
		p?.tipHeight != null ? `block ${p.tipHeight.toLocaleString('en-US')}` : null
	);
</script>

<svelte:head>
	<title>You're invited — Heartwood</title>
	<meta name="robots" content="noindex" />
</svelte:head>

<div class="page">
	<GroveField volume="grove" />

	<header class="head">
		<span class="brand">
			<HeartwoodMark size={24} tone="copper" detail="simple" />
			<span class="brand-word">Heartwood</span>
		</span>
	</header>

	{#if p}
		<main class="landing fade-in">
			<span class="eyebrow">You're invited aboard</span>
			<h1 class="node-name">{data.nodeTitle}</h1>
			{#if showCaptainLine}
				<p class="captain-line">{p.captainName} invited you.</p>
			{/if}

			{#if p.welcomeMessage}
				<blockquote class="welcome">
					<p>{p.welcomeMessage}</p>
					{#if p.captainName}<footer>— {p.captainName}</footer>{/if}
				</blockquote>
			{/if}

			<!-- The shared world, before any form: proof the node is alive. -->
			<section class="status-glass" aria-label="Node status">
				<div class="status-row">
					<span class="status-dot" class:live={p.watching} aria-hidden="true"></span>
					{#if p.watching && p.synced}
						<span class="status-text">
							Watching the chain{#if blockLine}&nbsp;·&nbsp;{blockLine}{/if}
						</span>
					{:else if p.watching}
						<span class="status-text">Getting to know the chain — almost ready</span>
					{:else}
						<span class="status-text">Resting right now — it'll be watching again soon</span>
					{/if}
				</div>
				{#if p.sharedSurfaces.explorer || p.sharedSurfaces.mining}
					<div class="surface-chips">
						{#if p.sharedSurfaces.explorer}
							<span class="chip"><Icon name="blocks" size={13} /> A live view of the chain</span>
						{/if}
						{#if p.sharedSurfaces.mining}
							<span class="chip"><Icon name="zap" size={13} /> The crew mines together</span>
						{/if}
					</div>
				{/if}
			</section>

			<!-- What joining means — three plain sentences, hairlines not boxes. -->
			<ul class="points">
				<li>
					<Icon name="shield" size={17} />
					<div>
						<span class="point-title">Your keys stay yours</span>
						<span class="point-body"
							>This node never holds your bitcoin and never sees your keys. Nothing here can move
							your money — only you can.</span
						>
					</div>
				</li>
				<li>
					<Icon name="eye" size={17} />
					<div>
						<span class="point-title">It watches, so you don't have to</span>
						<span class="point-body"
							>Day and night, this node keeps an eye on the chain for you — and tells you the
							moment your money moves.</span
						>
					</div>
				</li>
				<li>
					<Icon name="users" size={17} />
					<div>
						<span class="point-title">Run by someone you trust</span>
						<span class="point-body"
							>No company in the middle. {p.captainName ?? 'Your host'} runs this node and is
							sharing its view with you.</span
						>
					</div>
				</li>
			</ul>

			{#if data.signedIn}
				<a href="/" class="btn btn-primary cta">Open Heartwood <Icon name="arrow-right" size={15} /></a>
				<p class="alt">You're already signed in on this node.</p>
			{:else}
				<a href={`/signup?invite=${encodeURIComponent(data.code)}`} class="btn btn-primary cta">
					Come aboard <Icon name="arrow-right" size={15} />
				</a>
				<p class="alt">Already have an account here? <a href="/login">Sign in</a></p>
			{/if}
		</main>
	{:else}
		<main class="landing fade-in">
			<div class="empty-state">
				{#if data.throttled}
					<div class="empty-title">Give it a moment</div>
					<p>Too many invite links were tried from here just now. Wait a few minutes and open your
						link again.</p>
				{:else}
					<div class="empty-title">This invite isn't active</div>
					<p>The link may have expired or already been used. Ask the person who runs this node to
						send you a fresh one.</p>
				{/if}
				<a href="/login" class="btn btn-secondary" style="margin-top: 8px">Go to sign in</a>
			</div>
		</main>
	{/if}
</div>

<style>
	.page {
		position: relative;
		min-height: 100vh;
		display: flex;
		flex-direction: column;
		align-items: center;
		padding: 0 24px 64px;
	}

	.head {
		position: relative;
		z-index: 1;
		width: 100%;
		max-width: 560px;
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 28px 0 0;
	}

	.brand {
		display: inline-flex;
		align-items: center;
		gap: 9px;
	}

	.brand-word {
		font-family: var(--font-serif);
		font-size: 17px;
		font-weight: 600;
		color: var(--text);
	}

	.landing {
		position: relative;
		z-index: 1;
		width: 100%;
		max-width: 560px;
		display: flex;
		flex-direction: column;
		align-items: center;
		text-align: center;
		margin-top: 12vh;
	}

	.eyebrow {
		font-size: 11px;
		font-weight: 500;
		letter-spacing: 0.09em;
		text-transform: uppercase;
		color: var(--text-muted);
	}

	/* The one hero of this screen — the node's name, in the serif. */
	.node-name {
		font-family: var(--font-serif);
		font-size: clamp(34px, 8vw, 52px);
		font-weight: 440;
		letter-spacing: -0.02em;
		line-height: 1.06;
		color: var(--text-hero);
		margin: 14px 0 0;
		overflow-wrap: anywhere;
	}

	.captain-line {
		font-size: 15px;
		color: var(--text-secondary);
		margin: 10px 0 0;
	}

	.welcome {
		margin: 26px 0 0;
		padding: 0 8px;
		border: 0;
	}

	.welcome p {
		font-family: var(--font-serif);
		font-size: 17.5px;
		font-style: italic;
		line-height: 1.55;
		color: var(--text-rows);
		margin: 0;
		white-space: pre-line;
		overflow-wrap: anywhere;
	}

	.welcome footer {
		margin-top: 8px;
		font-size: 13px;
		color: var(--text-secondary);
	}

	/* Density panel — the instrument glass showing the node is alive. */
	.status-glass {
		width: 100%;
		margin-top: 34px;
		padding: 14px 18px;
		background: var(--surface-elevated);
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-panel, 14px);
		display: flex;
		flex-direction: column;
		gap: 10px;
	}

	.status-row {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 9px;
	}

	.status-dot {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: var(--text-faint);
		flex-shrink: 0;
	}

	/* Green means growth/health — a live, watching node qualifies. */
	.status-dot.live {
		background: var(--sage);
	}

	.status-text {
		font-size: 13.5px;
		color: var(--text-secondary);
		font-variant-numeric: tabular-nums;
	}

	.surface-chips {
		display: flex;
		flex-wrap: wrap;
		justify-content: center;
		gap: 8px;
	}

	.chip {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		font-size: 12.5px;
		color: var(--text-secondary);
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-badge, 999px);
		padding: 4px 11px;
	}

	.points {
		list-style: none;
		width: 100%;
		margin: 34px 0 0;
		padding: 0;
		text-align: left;
	}

	.points li {
		display: flex;
		gap: 14px;
		padding: 15px 4px;
		border-top: 1px solid var(--hairline);
		color: var(--text-secondary); /* icon color */
	}

	.points li:last-child {
		border-bottom: 1px solid var(--hairline);
	}

	.points li > div {
		display: flex;
		flex-direction: column;
		gap: 3px;
	}

	.point-title {
		font-size: 14.5px;
		font-weight: 600;
		color: var(--text);
	}

	.point-body {
		font-size: 13.5px;
		line-height: 1.5;
		color: var(--text-secondary);
	}

	.cta {
		margin-top: 34px;
		min-height: 52px;
		padding: 12px 34px;
		font-size: 15px;
		font-weight: 600;
		border-radius: var(--radius-pill, 26px);
	}

	.alt {
		margin-top: 14px;
		font-size: 13px;
		color: var(--text-muted);
	}

	.empty-state {
		margin-top: 8vh;
	}

	@media (max-width: 480px) {
		.landing {
			margin-top: 7vh;
		}

		.status-glass {
			padding: 12px 14px;
		}

		.cta {
			width: 100%;
		}
	}
</style>
