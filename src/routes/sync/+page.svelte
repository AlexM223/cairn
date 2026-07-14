<script lang="ts">
	// First sync — "counting the rings" (design 1a, Grove volume by nature).
	// The wood grows as the chain's history is counted; see FirstSyncGrowth
	// and src/lib/server/syncStatus.ts for what each phase really observes.
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import GroveField from '$lib/components/heartwood/GroveField.svelte';
	import HeartwoodMark from '$lib/components/heartwood/HeartwoodMark.svelte';
	import FirstSyncGrowth from '$lib/components/heartwood/FirstSyncGrowth.svelte';
	import { startBackoffPoll } from '$lib/backoffPoll';
	import type { SyncStatus } from '$lib/server/syncStatus';

	let { data } = $props();
	// svelte-ignore state_referenced_locally — intentional per-load seed; the
	// poll loop below takes over updating `status` after mount.
	let status = $state<SyncStatus>(data.status);

	const POLL_MS = 1200;
	// When the node is unreachable /api/sync keeps answering 200 (phase:
	// 'unreachable'); back off to this cap on that sustained-error condition rather
	// than polling every 1.2s forever (cairn-1f0a).
	const MAX_POLL_MS = 30_000;

	onMount(() => {
		return startBackoffPoll({
			baseMs: POLL_MS,
			maxMs: MAX_POLL_MS,
			poll: async () => {
				if (status.phase === 'synced') return 'stop'; // final state — stop asking
				const res = await fetch('/api/sync', { cache: 'no-store' });
				if (!res.ok) return 'backoff';
				const s = (await res.json()) as SyncStatus;
				status = s;
				if (s.phase === 'synced') return 'stop';
				// Sustained unreachable -> back off; any progressing phase -> base cadence.
				return s.phase === 'unreachable' ? 'backoff' : 'reset';
			}
		});
	});

	const synced = $derived(status.phase === 'synced');
	const unreachable = $derived(status.phase === 'unreachable');

	// ------------------------------------------------------------ counter tween
	// The serif hero ticks smoothly toward each polled frontier height instead
	// of jumping a whole epoch (2,016 blocks) per sample.
	let displayedHeight = $state(0);
	let tweenRaf = 0;
	$effect(() => {
		const target = synced ? (status.tipHeight ?? 0) : (status.frontierHeight ?? 0);
		cancelAnimationFrame(tweenRaf);
		const from = displayedHeight;
		if (from === target) return;
		const t0 = performance.now();
		const dur = 700;
		const step = (now: number) => {
			const k = Math.min(1, (now - t0) / dur);
			const ease = 1 - Math.pow(1 - k, 3);
			displayedHeight = Math.round(from + (target - from) * ease);
			if (k < 1) tweenRaf = requestAnimationFrame(step);
		};
		tweenRaf = requestAnimationFrame(step);
		return () => cancelAnimationFrame(tweenRaf);
	});

	function fmt(n: number | null): string {
		return n === null ? '—' : n.toLocaleString('en-US');
	}

	function etaLabel(seconds: number | null): string | null {
		if (seconds === null || seconds <= 0) return null;
		const h = Math.floor(seconds / 3600);
		const m = Math.max(1, Math.round((seconds % 3600) / 60));
		return `≈ ${h > 0 ? `${h} h ` : ''}${m} m remaining`;
	}

	const formingRing = $derived(
		status.tipHeight !== null ? Math.floor(status.tipHeight / 2016) + 1 : null
	);
	const formingBlocks = $derived(
		status.tipHeight !== null ? status.tipHeight - Math.floor(status.tipHeight / 2016) * 2016 : null
	);

	function goToApp() {
		// /sync is now an OPTIONAL details view (cairn-2zxt.1) — the (app) layout no
		// longer blocks on first sync, so this is a plain navigation back to the app
		// (no escape cookie needed). The count keeps running on the node either way.
		// replaceState (not a plain push): /sync is a transient details view, not a
		// stop on the user's real navigation path, so leaving it shouldn't add a
		// stack entry — otherwise Back from '/' returns to /sync instead of
		// wherever the "View details" link was clicked from, and a repeat
		// visit+leave cycle alternates Back between the two forever (same push-loop
		// shape as cairn-y7ac).
		void goto('/', { replaceState: true });
	}

	function enterApp() {
		void goto('/', { invalidateAll: true, replaceState: true });
	}
</script>

<svelte:head>
	<title>First sync — Heartwood</title>
</svelte:head>

<div class="sync-page">
	<GroveField volume="grove" />

	<header class="top">
		<div class="brand">
			<HeartwoodMark size={24} tone="copper" detail="simple" />
			<span class="wordmark">Heartwood</span>
		</div>
		<span class="server-pill" class:down={unreachable}>
			<span class="dot"></span>
			{status.server}
		</span>
	</header>

	<main class="center">
		<div class="wood">
			<FirstSyncGrowth
				epochsKnown={status.epochsKnown}
				epochsTotal={status.epochsTotal}
				{synced}
				formingProgress={status.formingProgress ?? 0}
			/>
		</div>

		<div class="panel">
			{#if synced}
				<div class="fade-in">
					<div class="state-line sage">
						<span class="blink-dot"></span>
						<span class="eyebrow sage-text">Synced · following the tip</span>
					</div>
					<div class="hero">{fmt(status.tipHeight)}</div>
					{#if formingRing !== null}
						<div class="forming">
							Ring {fmt(formingRing)} forming — {fmt(formingBlocks)} of 2,016 blocks
						</div>
					{/if}
					<p class="closing">Every ring counted from your own node. The wood is yours now.</p>
					<button class="btn btn-primary enter" onclick={enterApp}>Enter Heartwood</button>
				</div>
			{:else}
				<div>
					<div class="eyebrow">First sync · counting the rings</div>
					<div class="hero-row">
						<span class="hero">{fmt(displayedHeight || status.frontierHeight)}</span>
						{#if status.tipHeight !== null}
							<span class="hero-of">of {fmt(status.tipHeight)}</span>
						{/if}
					</div>
					<div class="bar">
						<div class="bar-fill" style:width="{status.percent}%"></div>
					</div>
					<div class="bar-caption">
						<span>{fmt(status.epochsKnown)} of {fmt(status.epochsTotal)} rings laid</span>
						<span>{status.percent}% counted</span>
					</div>

					{#if unreachable}
						<div class="note-card">
							<div class="note-title attention-text">The grove is out of reach</div>
							<div class="note-body">
								Heartwood can't reach your node right now. It keeps trying on its own — check the
								connection settings if this persists.
							</div>
						</div>
					{:else if status.phase === 'scanning' && status.scan}
						<div class="note-card">
							<div class="note-title">Reading your wallets</div>
							<div class="note-body attention-text">
								{fmt(status.scan.done)} of {fmt(status.scan.total)} addresses walked through the
								grove
							</div>
						</div>
					{:else if status.verifyingYear !== null}
						<div class="note-card">
							<div class="note-title">Verifying {status.verifyingYear}</div>
							{#if status.verifyingNote}
								<div class="note-body attention-text">{status.verifyingNote}</div>
							{/if}
						</div>
					{/if}

					<p class="explain">
						{#if status.phase === 'connecting'}
							Heartwood is reaching your node. The moment it answers, the counting begins.
						{:else if status.phase === 'scanning'}
							The rings are counted. Heartwood is now walking your wallets' addresses through
							them, gathering their history.
						{:else}
							Heartwood is reading the chain from your node — one ring for every difficulty epoch
							since January 2009. The wood remembers, so this only happens once.
						{/if}
					</p>

					<div class="meta">
						{#if status.peers !== null}
							<span>{status.peers} peers</span>
						{/if}
						{#if etaLabel(status.etaSeconds)}
							<span>{etaLabel(status.etaSeconds)}</span>
						{/if}
					</div>

					<div class="foot-note">
						You can leave this page anytime — the counting continues on the node, and the app is
						fully usable while it runs.
						<button class="skip" onclick={goToApp}>Back to Heartwood</button>
					</div>
				</div>
			{/if}
		</div>
	</main>

	<footer class="bottom">Self-hosted · No custodian · Read from your own node</footer>
</div>

<style>
	.sync-page {
		position: relative;
		min-height: 100vh;
		display: flex;
		flex-direction: column;
	}

	.top {
		position: relative;
		z-index: 1;
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 24px 30px 0;
	}

	.brand {
		display: flex;
		align-items: center;
		gap: 10px;
	}

	.wordmark {
		font: 600 16px var(--font-ui);
		letter-spacing: 0.01em;
		color: var(--text);
	}

	.server-pill {
		display: flex;
		align-items: center;
		gap: 7px;
		font: 500 11px ui-monospace, Menlo, monospace;
		color: var(--text-muted);
		background: var(--bg-input);
		border: 1px solid var(--border-control);
		border-radius: 20px;
		padding: 6px 12px;
	}

	.server-pill .dot {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: var(--sage);
		animation: hwBlink 2.4s ease-in-out infinite;
	}

	.server-pill.down .dot {
		background: var(--attention);
	}

	.center {
		position: relative;
		z-index: 1;
		flex: 1;
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 64px;
		padding: 0 60px;
	}

	.wood {
		width: 480px;
		height: 480px;
		flex: none;
	}

	.panel {
		width: 400px;
		flex: none;
	}

	.eyebrow {
		font: 600 10.5px var(--font-ui);
		letter-spacing: 0.2em;
		text-transform: uppercase;
		color: #b39a88;
	}

	.sage-text {
		color: var(--sage);
	}

	.attention-text {
		color: var(--attention);
	}

	.state-line {
		display: flex;
		align-items: center;
		gap: 8px;
	}

	.blink-dot {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: var(--sage);
		box-shadow: 0 0 8px rgba(138, 160, 110, 0.8);
		animation: hwBlink 2.4s ease-in-out infinite;
	}

	.hero-row {
		margin-top: 14px;
		display: flex;
		align-items: baseline;
		gap: 10px;
	}

	.hero {
		font-family: var(--font-serif);
		font-weight: 600;
		font-size: 46px;
		line-height: 1;
		color: var(--text-hero);
		letter-spacing: -0.01em;
		font-variant-numeric: tabular-nums;
	}

	.fade-in .hero {
		margin-top: 14px;
	}

	.hero-of {
		font: 400 13px var(--font-ui);
		color: var(--text-faint);
		font-variant-numeric: tabular-nums;
	}

	.bar {
		margin-top: 16px;
		height: 3px;
		border-radius: 2px;
		background: #241c18;
		overflow: hidden;
	}

	.bar-fill {
		height: 100%;
		background: linear-gradient(90deg, #b5673a, var(--accent));
		transition: width 0.9s ease;
	}

	.bar-caption {
		margin-top: 8px;
		display: flex;
		justify-content: space-between;
		font: 400 11.5px var(--font-ui);
		color: var(--text-muted);
		font-variant-numeric: tabular-nums;
	}

	.note-card {
		margin-top: 22px;
		padding: 14px 16px;
		background: #201a16;
		border: 1px solid var(--border-control);
		border-radius: 9px;
	}

	.note-title {
		font: 600 13.5px var(--font-ui);
		color: var(--text);
	}

	.note-body {
		margin-top: 5px;
		font: 400 12px/1.6 var(--font-ui);
		color: var(--text-secondary);
		font-variant-numeric: tabular-nums;
	}

	.explain {
		margin: 18px 0 0;
		font: 400 12.5px/1.7 var(--font-ui);
		color: var(--text-muted);
	}

	.meta {
		margin-top: 18px;
		display: flex;
		gap: 20px;
		font: 400 11.5px var(--font-ui);
		color: var(--text-faint);
		font-variant-numeric: tabular-nums;
	}

	.foot-note {
		margin-top: 20px;
		font: 400 11px var(--font-ui);
		color: var(--text-faint);
	}

	.skip {
		display: inline;
		border: none;
		background: none;
		padding: 0;
		margin-left: 6px;
		font: inherit;
		color: var(--text-muted);
		text-decoration: underline;
		text-underline-offset: 2px;
		cursor: pointer;
	}

	.skip:hover {
		color: var(--accent);
	}

	.forming {
		margin-top: 12px;
		font: 500 13px var(--font-ui);
		color: var(--text-secondary);
		font-variant-numeric: tabular-nums;
	}

	.closing {
		margin: 16px 0 0;
		font: 400 12.5px/1.7 var(--font-ui);
		color: var(--attention);
	}

	.enter {
		margin-top: 22px;
		min-height: 52px;
		padding: 12px 28px;
		border-radius: var(--radius-pill);
		font-size: 15px;
		font-weight: 600;
	}

	.fade-in {
		animation: syncFade 0.6s ease both;
	}

	@keyframes syncFade {
		from {
			opacity: 0;
			transform: translateY(6px);
		}

		to {
			opacity: 1;
			transform: none;
		}
	}

	.bottom {
		position: relative;
		z-index: 1;
		padding: 0 30px 22px;
		text-align: center;
		font: 400 11px var(--font-ui);
		color: var(--text-faint);
	}

	@media (max-width: 900px) {
		.center {
			flex-direction: column;
			gap: 34px;
			padding: 24px 20px;
		}

		.wood {
			width: min(78vw, 320px);
			height: min(78vw, 320px);
		}

		.panel {
			width: 100%;
			max-width: 400px;
		}

		.hero {
			font-size: 38px;
		}

		.enter {
			width: 100%;
		}
	}
</style>
