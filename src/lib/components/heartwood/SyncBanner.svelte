<script lang="ts">
	/**
	 * SyncBanner — the non-blocking first-sync indicator (cairn-2zxt.1).
	 *
	 * Cairn's first sync (counting one growth ring per difficulty epoch) used to
	 * hard-block behind the full-screen /sync page. It no longer does: every app
	 * route renders immediately and this slim copper banner surfaces live
	 * progress instead, without blocking anything on the page. It reuses the
	 * Heartwood ring vocabulary — the EpochDial fills as the count advances — and
	 * links to /sync for the full "counting the rings" view.
	 *
	 * The (app) layout renders this only while `firstSyncComplete` is false. The
	 * banner then polls /api/sync (the same endpoint the /sync page polls) for the
	 * real phase / ring counts / ETA, and removes itself the moment the count
	 * reaches 'synced' — no reload needed.
	 *
	 * cairn-7zjo: `phase === 'unreachable'` is derived from the exact same
	 * chain-transport signal as ChainHealthBanner's `unhealthy` (see
	 * syncStatus.ts's deriveSyncStatus — it requires `!chainHealthy`), so
	 * whenever this phase is reached, ChainHealthBanner (always mounted above
	 * this one in the layout) is necessarily already showing the "can't reach
	 * it" / "not connected yet" message for the identical root cause. This
	 * banner defers to it rather than stacking a second, redundant "can't
	 * reach your node" banner underneath.
	 */
	import { onMount } from 'svelte';
	import EpochDial from './EpochDial.svelte';
	import { startBackoffPoll } from '$lib/backoffPoll';
	import type { SyncStatus } from '$lib/server/syncStatus';

	// A background indicator, not the focused /sync screen — poll a little slower.
	const POLL_MS = 2500;
	// When the node is unreachable /api/sync keeps answering 200 (phase:
	// 'unreachable'), so a fixed-cadence loop would hammer it forever (cairn-1f0a).
	// Back off to this cap on that sustained-error condition, resetting to POLL_MS
	// the moment progress resumes.
	const MAX_POLL_MS = 30_000;

	let status = $state<SyncStatus | null>(null);
	let hidden = $state(false);

	const percent = $derived(status?.percent ?? 0);
	// 'unreachable' shows the dial's attention glyph; everything else is a
	// filling copper arc keyed to overall progress.
	const dialState = $derived<'syncing' | 'behind'>(
		status?.phase === 'unreachable' ? 'behind' : 'syncing'
	);
	// Same root cause as ChainHealthBanner's unhealthy state (both derive from
	// chainHealth.ts) — defer to it instead of stacking a second red banner
	// for one underlying problem (cairn-7zjo).
	const suppressed = $derived(status?.phase === 'unreachable');

	function fmt(n: number | null | undefined): string {
		return n === null || n === undefined ? '—' : n.toLocaleString('en-US');
	}

	function etaLabel(seconds: number | null | undefined): string | null {
		if (seconds === null || seconds === undefined || seconds <= 0) return null;
		const h = Math.floor(seconds / 3600);
		const m = Math.max(1, Math.round((seconds % 3600) / 60));
		return `~${h > 0 ? `${h} h ` : ''}${m} m left`;
	}

	function detail(s: SyncStatus | null): string {
		if (!s) return 'Counting the rings';
		if (s.phase === 'unreachable') return "Can't reach your node — still trying";
		if (s.phase === 'connecting') return 'Reaching your node…';
		if (s.phase === 'scanning' && s.scan) {
			return `Reading your wallets — ${fmt(s.scan.done)} of ${fmt(s.scan.total)} addresses`;
		}
		const rings =
			s.epochsTotal > 0 ? `Ring ${fmt(s.epochsKnown)} of ${fmt(s.epochsTotal)}` : 'Counting the rings';
		const eta = etaLabel(s.etaSeconds);
		return eta ? `${rings} · ${eta}` : rings;
	}

	onMount(() => {
		// Backoff-aware poll: base cadence while progressing, exponential backoff on
		// a sustained-error (unreachable) result or a thrown fetch, and stop for good
		// once synced (cairn-1f0a). Returns 'reset' | 'backoff' | 'stop' to drive it.
		return startBackoffPoll({
			baseMs: POLL_MS,
			maxMs: MAX_POLL_MS,
			poll: async () => {
				const res = await fetch('/api/sync', { cache: 'no-store' });
				if (!res.ok) return 'backoff'; // server error — don't hammer
				const s = (await res.json()) as SyncStatus;
				status = s;
				if (s.phase === 'synced') {
					// The wood is fully counted — dismiss for good and stop asking.
					hidden = true;
					return 'stop';
				}
				// 'unreachable' is a sustained error (banner defers to ChainHealthBanner
				// anyway) — back off; every other phase is real progress, poll at base.
				return s.phase === 'unreachable' ? 'backoff' : 'reset';
			}
		});
	});
</script>

{#if !hidden && !suppressed}
	<div class="sync-banner" role="status" aria-live="polite">
		<EpochDial state={dialState} progress={percent / 100} size={22} showPercent />
		<span class="grow">
			<strong>First sync</strong>
			<span class="detail">{detail(status)}</span>
		</span>
		<a class="details-link" href="/sync">View details</a>
	</div>
{/if}

<style>
	/* Copper-tinted, same shape/spacing as the layout's other banners (backup /
	   reminder / announcement) so it reads as part of the same family — but the
	   ring dial and accent tint mark it as the first-sync indicator. */
	.sync-banner {
		display: flex;
		align-items: center;
		gap: 12px;
		margin-bottom: 20px;
		padding: 9px 14px;
		font-size: 13px;
		line-height: 1.5;
		color: var(--text-secondary);
		background: var(--accent-muted);
		border: 1px solid var(--accent-border);
		border-radius: var(--radius-control);
	}

	.sync-banner :global(svg) {
		flex-shrink: 0;
	}

	.grow {
		flex: 1;
		min-width: 0;
	}

	.sync-banner strong {
		color: var(--text);
		margin-right: 6px;
	}

	.detail {
		color: var(--text-secondary);
		font-variant-numeric: tabular-nums;
	}

	.details-link {
		flex-shrink: 0;
		color: var(--accent);
		font-weight: 500;
		white-space: nowrap;
	}
</style>
