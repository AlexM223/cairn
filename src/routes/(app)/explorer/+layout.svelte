<script lang="ts">
	/**
	 * Explorer-wide snapshot-provenance caption (cairn-6efi QA P1-a, ported from
	 * explorer/heartwood-wave2). Every explorer sub-route (index / block / tx /
	 * mempool / difficulty) already renders its own NodeTrustChip from its own
	 * page load — this shared layout does NOT duplicate that chip. It adds one
	 * thing only: a quiet caption, shown whenever the chain transport reads
	 * disconnected AND a persisted chain snapshot exists, saying plainly that
	 * the page below is showing saved (possibly stale) data rather than letting
	 * it render silently with no acknowledgement that it might be old.
	 *
	 * Both inputs (`snapshotAt`, `disconnected`) come from +layout.server.ts as
	 * plain synchronous reads (readChainSnapshot() / gatherNodeTrust(), cairn-
	 * 6efi.3 — no chain call, no streaming needed), so this never blocks paint.
	 */
	import { timeAgo } from '$lib/format';

	let { data, children } = $props();

	const showSnapshotCaption = $derived(data.disconnected && data.snapshotAt !== null);
	const snapshotCaption = $derived(
		data.snapshotAt !== null ? `synced ${timeAgo(Math.floor(data.snapshotAt / 1000))}` : ''
	);
</script>

{#if showSnapshotCaption}
	<div class="snapshot-caption-row">
		<span class="snapshot-caption">
			Showing your last saved snapshot{snapshotCaption ? ` — ${snapshotCaption}` : ''}
		</span>
	</div>
{/if}

{@render children()}

<style>
	.snapshot-caption-row {
		display: flex;
		justify-content: flex-end;
		padding: 0 2px;
		margin-bottom: 4px;
	}

	.snapshot-caption {
		font-size: 11.5px;
		color: var(--text-muted);
		white-space: nowrap;
	}

	@media (max-width: 480px) {
		.snapshot-caption {
			display: none;
		}
	}
</style>
