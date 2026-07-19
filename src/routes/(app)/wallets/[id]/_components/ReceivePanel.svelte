<!--
	The canonical Receive surface (cairn-gt05.2, spec §2.4) — the audit's best
	disclosure pattern, kept VERBATIM: QR hero, "A fresh address, every time.",
	the address, Copy (filled) / rotate, and a collapsed Advanced › expander
	holding rotation detail (derivation path). Extracted from the wallet-detail
	page so the /wallets/[id]/receive subpage and the detail page's Receive tab
	render the exact same panel instead of duplicating it.

	The Rotate form posts to a ?/receive action on the HOST page (both hosts
	delegate to $lib/server/receiveRotate.ts), so `action` defaults to the
	page-local form action.
-->
<script lang="ts">
	import { enhance } from '$app/forms';
	import Icon from '$lib/components/Icon.svelte';
	import { copyToClipboard } from '$lib/clipboard';

	let {
		receive,
		serverError = null,
		neverFunded = false,
		action = '?/receive'
	}: {
		/** The address on display (with QR data-URL) — null while the node has
		 *  never been reachable, which renders the waiting state instead. */
		receive: { address: string; qr: string; index: number; path: string } | null;
		/** The host page's form?.receiveError, when a rotate failed server-side. */
		serverError?: string | null;
		/** Mechanism-fact confidence line for a never-funded wallet (gt05.6). */
		neverFunded?: boolean;
		/** Form action the Rotate form posts to. */
		action?: string;
	} = $props();

	let generating = $state(false);
	// Rotate can legitimately take 30-40s when a fresh gap-limit scan is needed
	// (cairn-2ic5): after a few seconds, reassure the user rather than leaving a
	// silent spinner that reads as a hung button.
	let rotateSlow = $state(false);
	let rotateSlowTimer: ReturnType<typeof setTimeout> | null = null;
	const ROTATE_SLOW_MS = 6000;
	// Client-side error surface for a Rotate that fails at the transport layer
	// (network unreachable, 500, thrown action) — those come back as
	// result.type === 'error', which update() applies nothing for (cairn-sz1q).
	let rotateError = $state<string | null>(null);

	let showReceiveAdvanced = $state(false);

	let addrCopied = $state(false);
	async function copyAddress() {
		if (!receive) return;
		if (await copyToClipboard(receive.address)) {
			addrCopied = true;
			setTimeout(() => (addrCopied = false), 1500);
		}
	}
</script>

{#if receive}
	<div class="hw-receive-grid">
		<div class="hw-qr-wrap">
			<img
				class="hw-qr"
				src={receive.qr}
				alt="QR code for {receive.address}"
				width="300"
				height="300"
			/>
		</div>
		<div class="hw-receive-meta">
			<h2 class="hw-receive-headline">A fresh address, every time.</h2>
			<div class="hw-addr-row">
				<span class="mono hw-addr">{receive.address}</span>
			</div>
			{#if rotateError || serverError}
				<div class="form-error" role="alert">{rotateError ?? serverError}</div>
			{/if}
			<div class="hw-receive-actions">
				<button type="button" class="btn btn-secondary hw-pill" onclick={copyAddress}>
					<Icon name={addrCopied ? 'check' : 'copy'} size={14} />
					{addrCopied ? 'Copied' : 'Copy'}
				</button>
				<form
					method="POST"
					{action}
					use:enhance={() => {
						generating = true;
						rotateSlow = false;
						rotateError = null;
						if (rotateSlowTimer) clearTimeout(rotateSlowTimer);
						rotateSlowTimer = setTimeout(() => (rotateSlow = true), ROTATE_SLOW_MS);
						return async ({ result, update }) => {
							if (rotateSlowTimer) clearTimeout(rotateSlowTimer);
							rotateSlowTimer = null;
							generating = false;
							rotateSlow = false;
							// A transport-level failure (network unreachable, 500, thrown
							// action) arrives as 'error' and carries no form data, so
							// update() would leave the UI silent. Surface it ourselves.
							if (result.type === 'error') {
								rotateError =
									"Couldn't get a fresh address — check your connection and try again.";
								return;
							}
							await update({ reset: false });
						};
					}}
				>
					<input type="hidden" name="current" value={receive.index} />
					<button class="btn btn-secondary hw-pill" disabled={generating}>
						{#if generating}<span class="spinner"></span>{:else}<Icon
								name="refresh"
								size={14}
							/>{/if}
						{generating ? (rotateSlow ? 'Still working…' : 'Rotating…') : 'Rotate'}
					</button>
				</form>
			</div>
			{#if generating && rotateSlow}
				<p class="hw-rotate-status" role="status" aria-live="polite">
					Still finding your next unused address — checking the chain can take a moment on a
					busy node. Hang tight.
				</p>
			{/if}
			<p class="hw-caption">
				A new address for every payment keeps your history private. Old addresses keep
				working forever — rotating never breaks anything.
			</p>
			{#if neverFunded}
				<!-- Mechanism-fact confidence line (cairn-gt05.6, F17) — answers
				     "is this really mine" for a never-funded wallet's first
				     receive view, without reassurance-theater. -->
				<p class="hw-caption">
					This address belongs to your wallet. Anything sent to it is controlled only by
					your keys — nobody else can move it. You can share it or reuse this flow as
					often as you like.
				</p>
			{/if}
			<div class="disclosure hw-receive-advanced">
				<button
					type="button"
					class="disclosure-toggle"
					onclick={() => (showReceiveAdvanced = !showReceiveAdvanced)}
					aria-expanded={showReceiveAdvanced}
				>
					<Icon name="settings" size={14} />
					Advanced
					<span class="chev" class:open={showReceiveAdvanced}
						><Icon name="chevron-down" size={14} /></span
					>
				</button>
				{#if showReceiveAdvanced}
					<div class="disclosure-body fade-in">
						<span class="hw-addr-path mono">Derivation path: {receive.path}</span>
					</div>
				{/if}
			</div>
		</div>
	</div>
{:else}
	<div class="hw-receive-empty">
		<h2 class="hw-receive-headline">Still connecting to your node</h2>
		<p class="hw-caption">
			We can't show your receive address until we reach your node. This usually clears up
			in a few seconds — check back shortly, or use the refresh button above.
		</p>
	</div>
{/if}

<style>
	.hw-receive-grid {
		display: grid;
		grid-template-columns: auto 1fr;
		gap: 44px;
		align-items: center;
	}

	.hw-qr-wrap {
		padding: 10px;
	}

	.hw-qr {
		display: block;
		width: 300px;
		height: 300px;
		image-rendering: pixelated;
	}

	.hw-receive-meta {
		display: flex;
		flex-direction: column;
		gap: 14px;
		min-width: 0;
	}

	.hw-receive-headline {
		font-size: 22px;
		font-weight: 600;
		letter-spacing: -0.01em;
		color: var(--text-hero);
	}

	.hw-addr-row {
		border-bottom: 1px solid var(--hairline);
		padding-bottom: 12px;
		display: flex;
		flex-direction: column;
		gap: 5px;
		min-width: 0;
	}

	.hw-addr {
		font-size: 15px;
		color: var(--text-rows);
		word-break: break-all;
		line-height: 1.5;
	}

	.hw-addr-path {
		font-size: 11px;
		color: var(--text-faint);
	}

	.hw-caption {
		margin-top: 0;
		font-size: 11.5px;
		color: var(--eyebrow-path);
		line-height: 1.6;
	}

	.hw-pill {
		height: 52px;
		padding: 0 30px;
		font-size: 15px;
		font-weight: 600;
		border-radius: var(--radius-pill);
	}

	/* Advanced disclosure (matches the multisig detail page's convention). */
	.hw-receive-advanced {
		margin-top: 4px;
	}

	.disclosure {
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-control);
		overflow: hidden;
	}

	.disclosure-toggle {
		display: flex;
		align-items: center;
		gap: 8px;
		width: 100%;
		padding: 10px 12px;
		background: transparent;
		border: none;
		color: var(--text-secondary);
		font: inherit;
		font-size: 12.5px;
		font-weight: 500;
		cursor: pointer;
		text-align: left;
	}

	.disclosure-toggle:hover {
		color: var(--text);
	}

	.disclosure-toggle:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: -2px;
	}

	.chev {
		margin-left: auto;
		display: inline-flex;
		transition: transform 140ms var(--ease);
	}

	.chev.open {
		transform: rotate(180deg);
	}

	.disclosure-body {
		padding: 2px 12px 12px;
	}

	.hw-receive-actions {
		display: flex;
		gap: 10px;
		flex-wrap: wrap;
	}

	.hw-rotate-status {
		margin: 10px 0 0;
		font-size: 12px;
		line-height: 1.5;
		color: var(--text-faint);
	}

	.hw-receive-empty {
		display: flex;
		flex-direction: column;
		gap: 10px;
		padding: 8px 0;
	}

	.hw-receive-empty .hw-receive-headline {
		font-size: 18px;
	}

	@media (max-width: 860px) {
		.hw-receive-grid {
			grid-template-columns: 1fr;
			gap: 22px;
			justify-items: center;
			text-align: center;
		}

		.hw-receive-meta {
			align-items: center;
			width: 100%;
		}

		.hw-addr-row {
			align-items: center;
			width: 100%;
		}

		.hw-qr {
			width: 228px;
			height: 228px;
		}
	}
</style>
