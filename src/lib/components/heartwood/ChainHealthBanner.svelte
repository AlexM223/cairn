<script lang="ts">
	/**
	 * ChainHealthBanner — instance-wide "can't reach the Bitcoin network" warning
	 * (cairn-hy8z).
	 *
	 * A misconfigured SOCKS5/Tor proxy (or an unreachable Electrum server) used to
	 * degrade ALL chain traffic silently: the dashboard and wallet pages just sat
	 * on skeleton loaders while every scan slowly timed out, with nothing telling
	 * the user or admin the transport itself was the problem. This slim warning
	 * banner surfaces that condition wherever the user is in the app.
	 *
	 * It follows the SyncBanner pattern exactly — a slim banner in the (app) layout
	 * that polls a cheap API endpoint — but is always mounted and renders nothing
	 * until the transport is actually unhealthy. The /api/chain-health read is an
	 * in-memory, last-known signal (no fresh probe), so this poll adds no chain
	 * traffic of its own.
	 *
	 * cairn-7zjo: this is the SOLE owner of the "chain unreachable" root cause.
	 * SyncBanner's own 'unreachable' phase is derived from the exact same
	 * chainHealth signal (see syncStatus.ts's deriveSyncStatus), so it hides
	 * itself whenever this banner is showing instead of duplicating the message
	 * — no two banners ever both go red for one underlying cause.
	 *
	 * It also distinguishes two causes that used to look identical: a FRESH
	 * install that has never had its connection touched (still on the public
	 * default, no admin/auto-connect action ever recorded — health.neverConfigured)
	 * renders a calm, neutral "not connected yet" notice instead of a red error,
	 * since nothing is actually broken — nobody has set this up yet. An instance
	 * that WAS configured (custom, or Umbrel auto-connected) and has since gone
	 * unreachable still gets the real warning-styled "can't reach it" banner.
	 */
	import { onMount } from 'svelte';
	import Icon from '$lib/components/Icon.svelte';
	import type { ChainHealth } from '$lib/server/chainHealth';

	// Whether the viewer can act on this — only admins get the settings link.
	let { isAdmin = false }: { isAdmin?: boolean } = $props();

	// A background health signal, not a progress bar — poll slowly.
	const POLL_MS = 15_000;

	let health = $state<ChainHealth | null>(null);

	const unhealthy = $derived(health !== null && !health.healthy);

	function agoLabel(atMs: number | null): string | null {
		if (atMs === null) return null;
		const secs = Math.max(0, Math.round((Date.now() - atMs) / 1000));
		if (secs < 60) return 'just now';
		const mins = Math.round(secs / 60);
		if (mins < 60) return `${mins}m ago`;
		const hrs = Math.round(mins / 60);
		return `${hrs}h ago`;
	}

	function headline(h: ChainHealth): string {
		if (h.neverConfigured) return "Heartwood isn't connected to the Bitcoin network yet.";
		return h.proxyConfigured
			? "Can't reach the Bitcoin network through the configured proxy."
			: "Can't reach the Bitcoin network.";
	}

	function subline(h: ChainHealth): string {
		if (h.neverConfigured) {
			return isAdmin
				? 'Balances and history will appear once a node or server is connected.'
				: 'Balances and history will appear once your instance operator connects it. Ask your instance operator.';
		}
		const when = agoLabel(h.lastErrorAt);
		const proxy = h.proxyConfigured
			? 'Check that your SOCKS5/Tor proxy is running and reachable.'
			: 'Check your node connection.';
		const detail = when ? `Last connection failed ${when}. ` : '';
		return `Balances and history may be stale until it reconnects. ${detail}${
			isAdmin ? proxy : 'Your instance operator has been notified.'
		}`;
	}

	onMount(() => {
		let done = false;
		async function poll(): Promise<void> {
			if (done) return;
			try {
				const res = await fetch('/api/chain-health', { cache: 'no-store' });
				if (res.ok) health = (await res.json()) as ChainHealth;
			} catch {
				// A missed poll is fine; the next tick catches up.
			}
		}
		void poll(); // reflect current state immediately, don't wait a full interval
		const timer = setInterval(poll, POLL_MS);
		return () => {
			done = true;
			clearInterval(timer);
		};
	});
</script>

{#if unhealthy && health}
	<div
		class="chain-health-banner"
		class:neutral={health.neverConfigured}
		role="status"
		aria-live="polite"
	>
		<Icon name={health.neverConfigured ? 'server' : 'alert-triangle'} size={16} />
		<span class="grow">
			<strong>{headline(health)}</strong>
			<span class="detail">{subline(health)}</span>
			{#if isAdmin}
				<a href="/admin/settings">
					{health.neverConfigured ? 'Connect a node' : 'Review connection settings'}
				</a>
			{/if}
		</span>
	</div>
{/if}

<style>
	/* Warning-tinted, same shape/spacing as the layout's other banners (sync /
	   backup / announcement) so it reads as part of the same family. */
	.chain-health-banner {
		display: flex;
		align-items: center;
		gap: 10px;
		margin-bottom: 20px;
		padding: 10px 14px;
		font-size: 13px;
		line-height: 1.5;
		color: var(--text-secondary);
		background: var(--warning-muted);
		border: 1px solid var(--warning-border);
		border-radius: var(--radius-control);
	}

	.chain-health-banner :global(svg) {
		color: var(--warning);
		flex-shrink: 0;
	}

	/* A fresh, never-configured instance isn't broken — nobody has set it up
	   yet. Same shape as the layout's own gentle .reminder-banner (soft
	   surface fill, muted icon) so the calm state doesn't read as an error. */
	.chain-health-banner.neutral {
		background: var(--surface);
		border-color: var(--border-subtle);
	}

	.chain-health-banner.neutral :global(svg) {
		color: var(--text-muted);
	}

	.grow {
		flex: 1;
		min-width: 0;
	}

	.chain-health-banner strong {
		color: var(--text);
		margin-right: 6px;
	}

	.detail {
		color: var(--text-secondary);
	}

	.chain-health-banner a {
		color: var(--accent);
		font-weight: 500;
		margin-left: 6px;
		white-space: nowrap;
	}
</style>
