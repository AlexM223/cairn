<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import Icon from '$lib/components/Icon.svelte';
	import HeartwoodMark from '$lib/components/heartwood/HeartwoodMark.svelte';
	import {
		WELCOME_PROGRESS_KEY,
		WELCOME_STEPS,
		parseSavedWelcomeProgress,
		type WelcomeStepKey
	} from './_components/welcomeProgress';

	let { data } = $props();

	let step = $state<WelcomeStepKey>('aboard');

	const stepIndex = $derived(WELCOME_STEPS.indexOf(step));

	// Resume a reload-interrupted tour (Umbrel's app_proxy can force one), then
	// snapshot every step change. Terminal navigation clears the snapshot.
	onMount(() => {
		const saved = parseSavedWelcomeProgress(
			sessionStorage.getItem(WELCOME_PROGRESS_KEY),
			Date.now()
		);
		if (saved) step = saved.step;
	});

	function saveStep(next: WelcomeStepKey) {
		step = next;
		try {
			sessionStorage.setItem(WELCOME_PROGRESS_KEY, JSON.stringify({ step: next, savedAt: Date.now() }));
		} catch {
			// Storage full/blocked — the tour still works, it just won't resume.
		}
	}

	function forward() {
		const i = WELCOME_STEPS.indexOf(step);
		if (i < WELCOME_STEPS.length - 1) saveStep(WELCOME_STEPS[i + 1]);
	}

	function back() {
		const i = WELCOME_STEPS.indexOf(step);
		if (i > 0) saveStep(WELCOME_STEPS[i - 1]);
	}

	async function finish(target: string) {
		try {
			sessionStorage.removeItem(WELCOME_PROGRESS_KEY);
		} catch {
			/* ignore */
		}
		await goto(target);
	}
</script>

<svelte:head>
	<title>Welcome aboard — Heartwood</title>
</svelte:head>

<div class="tour fade-in">
	<div class="dots" role="progressbar" aria-valuenow={stepIndex + 1} aria-valuemin={1} aria-valuemax={WELCOME_STEPS.length}>
		{#each WELCOME_STEPS as s (s)}
			<span class="dot" class:on={WELCOME_STEPS.indexOf(s) <= stepIndex}></span>
		{/each}
	</div>

	{#if step === 'aboard'}
		<div class="step">
			<HeartwoodMark size={52} tone="copper" detail="full" />
			<span class="eyebrow">Welcome aboard</span>
			<h1 class="hero">{data.nodeTitle}</h1>
			<p class="lede">
				You've joined a node that someone you trust runs themselves — no company, no third party,
				just their machine watching the Bitcoin network directly.
			</p>
			<p class="lede">
				One thing before anything else: <strong>your keys stay yours.</strong> This node can see,
				watch, and tell you about your bitcoin — it can never touch it. Only your own devices can
				sign anything away.
			</p>
			<button class="btn btn-primary next" onclick={forward}>
				Show me around <Icon name="arrow-right" size={15} />
			</button>
			<button class="skip" onclick={() => finish('/')}>Skip the tour</button>
		</div>
	{:else if step === 'view'}
		<div class="step">
			<span class="eyebrow">Step 2</span>
			<h1 class="hero small">What you can see here</h1>
			<ul class="rows">
				<li>
					<Icon name="wallet" size={17} />
					<div>
						<span class="row-title">Your own wallets</span>
						<span class="row-body"
							>Add a wallet and this node watches it for you — balances, payments, history — while
							the keys stay on your devices.</span
						>
					</div>
				</li>
				{#if data.sharedWallets > 0}
					<li>
						<Icon name="users" size={17} />
						<div>
							<span class="row-title">
								{data.sharedWallets === 1
									? 'A shared wallet is already waiting for you'
									: `${data.sharedWallets} shared wallets are already waiting for you`}
							</span>
							<span class="row-body"
								>Someone here added you to a wallet you hold keys for together. When money is
								about to move, it needs enough of you to approve — you'll find it under Wallets.</span
							>
						</div>
					</li>
				{:else}
					<li>
						<Icon name="users" size={17} />
						<div>
							<span class="row-title">Wallets you share</span>
							<span class="row-body"
								>People on this node can hold a wallet together, where moving money takes more
								than one person's approval. If someone adds you to one, it appears under Wallets.</span
							>
						</div>
					</li>
				{/if}
				{#if data.flags?.explorer}
					<li>
						<Icon name="blocks" size={17} />
						<div>
							<span class="row-title">The chain, live</span>
							<span class="row-body"
								>The Explorer shows what this node sees on the Bitcoin network right now — blocks
								arriving, your transactions confirming.</span
							>
						</div>
					</li>
				{/if}
				{#if data.flags?.mining}
					<li>
						<Icon name="zap" size={17} />
						<div>
							<span class="row-title">The crew mines together</span>
							<span class="row-body"
								>This node runs its own small mining pool, with a leaderboard for the best shares
								found. A long shot — and a shared one.</span
							>
						</div>
					</li>
				{/if}
			</ul>
			<button class="btn btn-primary next" onclick={forward}>
				Continue <Icon name="arrow-right" size={15} />
			</button>
			<button class="skip" onclick={back}>Back</button>
		</div>
	{:else if step === 'notify'}
		<div class="step">
			<span class="eyebrow">Step 3</span>
			<h1 class="hero small">You'll hear the moment money moves</h1>
			<p class="lede">
				This node doesn't wait for you to check in. When bitcoin arrives, leaves, or needs your
				approval, it tells you — starting with notifications right here in the app, from day one.
			</p>
			<p class="lede">
				To hear about it even when Heartwood isn't open, add a channel you actually read — email,
				Telegram, and more — under
				<a href="/settings/notifications">Settings&nbsp;→&nbsp;Notifications</a>. Two minutes, worth
				it.
			</p>
			<button class="btn btn-primary next" onclick={forward}>
				Continue <Icon name="arrow-right" size={15} />
			</button>
			<button class="skip" onclick={back}>Back</button>
		</div>
	{:else}
		<div class="step">
			<span class="eyebrow">All set</span>
			<h1 class="hero small">Make it yours</h1>
			<p class="lede">
				That's the whole idea: a node someone you trust runs, watching your bitcoin, with your keys
				staying in your hands. The best first step is adding a wallet to watch.
			</p>
			<button class="btn btn-primary next" onclick={() => finish('/wallets/new')}>
				Add your first wallet <Icon name="arrow-right" size={15} />
			</button>
			<button class="skip" onclick={() => finish('/')}>Just look around first</button>
		</div>
	{/if}
</div>

<style>
	.tour {
		max-width: 560px;
		margin: 0 auto;
		padding: 40px 20px 64px;
		display: flex;
		flex-direction: column;
		align-items: center;
	}

	.dots {
		display: flex;
		gap: 7px;
		margin-bottom: 40px;
	}

	.dot {
		width: 7px;
		height: 7px;
		border-radius: 50%;
		background: var(--border);
		transition: background 130ms var(--ease);
	}

	.dot.on {
		background: var(--accent);
	}

	.step {
		display: flex;
		flex-direction: column;
		align-items: center;
		text-align: center;
		width: 100%;
	}

	.eyebrow {
		font-size: 11px;
		font-weight: 500;
		letter-spacing: 0.09em;
		text-transform: uppercase;
		color: var(--text-muted);
		margin-top: 18px;
	}

	.hero {
		font-family: var(--font-serif);
		font-size: clamp(30px, 7vw, 44px);
		font-weight: 440;
		letter-spacing: -0.02em;
		line-height: 1.08;
		color: var(--text-hero);
		margin: 10px 0 0;
		overflow-wrap: anywhere;
	}

	.hero.small {
		font-size: clamp(26px, 6vw, 34px);
	}

	.lede {
		font-size: 15px;
		line-height: 1.55;
		color: var(--text-secondary);
		margin: 18px 0 0;
		max-width: 46ch;
	}

	.lede strong {
		color: var(--text);
	}

	.lede a {
		color: var(--text);
		text-decoration: underline;
		text-underline-offset: 3px;
	}

	.rows {
		list-style: none;
		width: 100%;
		margin: 26px 0 0;
		padding: 0;
		text-align: left;
	}

	.rows li {
		display: flex;
		gap: 14px;
		padding: 15px 4px;
		border-top: 1px solid var(--hairline);
		color: var(--text-secondary);
	}

	.rows li:last-child {
		border-bottom: 1px solid var(--hairline);
	}

	.rows li > div {
		display: flex;
		flex-direction: column;
		gap: 3px;
	}

	.row-title {
		font-size: 14.5px;
		font-weight: 600;
		color: var(--text);
	}

	.row-body {
		font-size: 13.5px;
		line-height: 1.5;
		color: var(--text-secondary);
	}

	.next {
		margin-top: 34px;
		min-height: 48px;
		padding: 12px 30px;
		border-radius: var(--radius-pill, 26px);
		font-size: 15px;
		font-weight: 600;
	}

	.skip {
		margin-top: 14px;
		background: none;
		border: none;
		font-size: 13px;
		color: var(--text-muted);
		cursor: pointer;
		padding: 6px 10px;
	}

	.skip:hover {
		color: var(--text-secondary);
	}

	@media (max-width: 480px) {
		.tour {
			padding-top: 24px;
		}

		.next {
			width: 100%;
		}
	}
</style>
