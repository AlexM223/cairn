<script lang="ts">
	// Small, quiet freshness indicator for the stale-while-revalidate pages
	// (cairn-2zxt). Shows "Updating…" with a pulsing copper dot while a background
	// refresh is in flight, otherwise a live relative "synced Xs/m/h ago" (or
	// "never synced" before the first sync). Muted secondary text, copper accent —
	// it should read as ambient reassurance, never as a call to action.
	import { onMount } from 'svelte';

	let {
		lastSyncedAt,
		syncing
	}: {
		/** ms epoch of the last successful sync, or null if never synced. */
		lastSyncedAt: number | null;
		/** A background refresh is currently in flight. */
		syncing: boolean;
	} = $props();

	// Re-tick so the relative label advances while the page sits idle.
	let now = $state(Date.now());
	onMount(() => {
		const t = setInterval(() => (now = Date.now()), 15_000);
		return () => clearInterval(t);
	});

	function relative(ms: number, ref: number): string {
		const diff = Math.max(0, Math.floor((ref - ms) / 1000));
		if (diff < 5) return 'just now';
		if (diff < 60) return `${diff}s ago`;
		if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
		if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
		return `${Math.floor(diff / 86400)}d ago`;
	}

	const label = $derived(
		syncing
			? 'Updating…'
			: lastSyncedAt === null
				? 'never synced'
				: `synced ${relative(lastSyncedAt, now)}`
	);
</script>

<span class="sync-indicator" class:syncing role="status" aria-live="polite" title={label}>
	<span class="dot" aria-hidden="true"></span>
	<span class="text">{label}</span>
</span>

<style>
	.sync-indicator {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		font-size: 11.5px;
		color: var(--text-muted);
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
	}

	.dot {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: var(--accent);
		flex-shrink: 0;
		opacity: 0.55;
	}

	.syncing .text {
		color: var(--accent);
	}

	.syncing .dot {
		opacity: 1;
		animation: sync-pulse 1.1s ease-in-out infinite;
	}

	@keyframes sync-pulse {
		0%,
		100% {
			opacity: 0.35;
			transform: scale(0.85);
		}
		50% {
			opacity: 1;
			transform: scale(1.15);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.syncing .dot {
			animation: none;
		}
	}
</style>
