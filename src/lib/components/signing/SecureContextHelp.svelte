<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import Icon from '$lib/components/Icon.svelte';

	// The way out of the insecure-context trap (cairn-wgr8). Umbrel serves
	// Cairn over plain HTTP, where browsers withhold WebHID / Web Serial /
	// WebUSB (USB hardware signing) and the camera (QR scan-back). Cairn runs
	// its own self-signed HTTPS listener for exactly this; this box appears
	// ONLY when the current page is an insecure context AND the server reports
	// that listener's port (page.data.httpsPort) — and offers the same path on
	// the secure origin, with plain-language warning-bypass guidance.
	//
	// `what` names the capability that needs the secure page, so the copy reads
	// naturally in each host card ("Ledger signing", "camera scanning", …).
	let { what = 'USB signing' }: { what?: string } = $props();

	// Probed after mount only: window/isSecureContext don't exist during SSR.
	let insecure = $state(false);
	let secureHref = $state<string | null>(null);

	onMount(() => {
		const port = page.data.httpsPort as number | null | undefined;
		if (window.isSecureContext || !port) return;
		insecure = true;
		const { hostname, pathname, search } = window.location;
		secureHref = `https://${hostname}:${port}${pathname}${search}`;
	});
</script>

{#if insecure && secureHref}
	<div class="secure-help" role="note">
		<span class="secure-icon"><Icon name="shield" size={16} /></span>
		<div>
			<p class="secure-title">Use Cairn's secure address for {what}</p>
			<p class="secure-body">
				Your browser only allows {what} on a secure (HTTPS) page, and this page came over plain
				HTTP. This Cairn server has a secure address built in:
			</p>
			<a class="btn btn-secondary btn-sm secure-cta" href={secureHref}>
				<Icon name="shield" size={14} />
				Open the secure address
			</a>
			<p class="secure-note">
				The first visit shows a browser warning about the certificate. That's expected — it's the
				certificate your own Cairn server created for itself, not a public website's. Choose
				<strong>Advanced</strong> → <strong>Continue</strong> once; the browser remembers it. You may
				need to sign in again there.
			</p>
		</div>
	</div>
{/if}

<style>
	.secure-help {
		display: flex;
		gap: 10px;
		align-items: flex-start;
		margin-top: 12px;
		padding: 12px 14px;
		border: 1px solid var(--border);
		border-radius: 8px;
		background: var(--bg-subtle, rgba(127, 127, 127, 0.06));
	}

	.secure-icon {
		color: var(--accent);
		display: inline-flex;
		margin-top: 2px;
	}

	.secure-title {
		font-weight: 600;
		font-size: 13.5px;
		margin: 0 0 4px;
	}

	.secure-body,
	.secure-note {
		font-size: 12.5px;
		color: var(--text-secondary);
		line-height: 1.55;
		margin: 0;
	}

	.secure-cta {
		margin: 8px 0;
	}

	.secure-note {
		color: var(--text-muted);
	}
</style>
