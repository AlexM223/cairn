<script lang="ts">
	import QrScanner from '$lib/components/QrScanner.svelte';
	import Icon from '$lib/components/Icon.svelte';
	import CopyText from '$lib/components/CopyText.svelte';
	import { parseKeyOriginInput } from '$lib/hw/keyOrigin';
	import { normalizeXpub } from '$lib/hw/common';
	import type { ScannedKeyImport } from '$lib/hw/bcurKey';

	// Caravan-informed QR cosigner-key import (CARAVAN-QR-REFERENCE.md). Wraps
	// the shared QrScanner (mode="animated" codec="bcur-key") — native
	// BarcodeDetector camera + the animated BC-UR accumulator/progress bar it
	// already renders — and adds the pieces Caravan's own importer does (plus
	// the two gaps Caravan itself leaves on the table, per the reference doc's
	// §5):
	//   - a visible "converted from tpub to xpub" notice when the scanned key's
	//     own network metadata said testnet (Heartwood tracks mainnet only; the
	//     xpub is always REBUILT under Heartwood's own version bytes — see
	//     bcurKey.ts's buildXpub — so this is a transparency notice, not a
	//     behavior change)
	//   - the root fingerprint shown PROMINENTLY for an eyeball-match against
	//     the device's own screen (Caravan never shows it back at all)
	//   - an explicit "this matches my device — add it" confirm step before
	//     anything is accepted (Caravan has only a destructive "Remove")
	//   - a duplicate-xpub-across-cosigner-slots check, surfaced here as soon
	//     as the scan completes (the generic add-key pipeline in +page.svelte
	//     also rejects a dupe once submitKey() runs — this is the same check,
	//     client-side canonicalized, just surfaced BEFORE the confirm button
	//     rather than after)
	// Secure-context / camera gating and the always-available paste fallback
	// are inherited entirely from QrScanner.svelte — nothing extra needed here.
	type VaultMode = 'collaborative' | 'personal';

	let {
		vaultMode,
		existingKeys,
		onaccepted,
		cameraDisabled = false
	}: {
		vaultMode: VaultMode;
		/** Already-added cosigner keys, for the duplicate-xpub check. */
		existingKeys: { name: string; xpub: string }[];
		onaccepted: (key: { xpub: string; fingerprint: string; path: string }) => void;
		/** The admin-facing `qr_scan` feature flag — forwarded straight to
		 *  QrScanner's `forceNoCamera` so the paste fallback still renders. */
		cameraDisabled?: boolean;
	} = $props();

	interface Normalized {
		xpub: string;
		fingerprint: string | null;
		path: string | null;
		convertedFromTestnet: boolean;
	}

	let pending = $state<Normalized | null>(null);
	let scanError = $state<string | null>(null);

	function normalize(raw: ScannedKeyImport): Normalized {
		if (raw.kind === 'plain') {
			const parsed = parseKeyOriginInput(raw.xpub);
			return { xpub: parsed.xpub, fingerprint: parsed.fingerprint, path: parsed.path, convertedFromTestnet: false };
		}
		return {
			xpub: raw.xpub,
			fingerprint: raw.fingerprint,
			path: raw.bip32Path,
			convertedFromTestnet: raw.convertedFromTestnet
		};
	}

	const duplicateOf = $derived(
		pending
			? (existingKeys.find((k) => normalizeXpub(k.xpub) === normalizeXpub(pending!.xpub)) ?? null)
			: null
	);

	function handleResult(json: string) {
		scanError = null;
		let raw: ScannedKeyImport;
		try {
			raw = JSON.parse(json) as ScannedKeyImport;
		} catch {
			scanError = 'Could not read that QR code — try again, or paste the key instead.';
			return;
		}
		try {
			pending = normalize(raw);
		} catch (e) {
			scanError = e instanceof Error ? e.message : 'Could not read that key.';
		}
	}

	function rescan() {
		pending = null;
		scanError = null;
	}

	function accept() {
		if (!pending || duplicateOf) return;
		onaccepted({
			xpub: pending.xpub,
			fingerprint: pending.fingerprint ?? '',
			path: pending.path ?? ''
		});
		pending = null;
	}
</script>

{#if pending}
	<div class="qki-confirm fade-in">
		<span class="qki-title">
			<Icon name="check" size={15} />
			Key scanned — check it against the device before adding it
		</span>

		{#if pending.convertedFromTestnet}
			<div class="qki-convert-note" role="status">
				<Icon name="info" size={13} />
				<span>
					This key's own data says it was exported for Bitcoin Testnet — Heartwood tracks mainnet,
					so it's been rebuilt as a mainnet key (converted from <span class="mono">tpub</span> to
					<span class="mono">xpub</span>). Double-check this device is actually set up for mainnet
					before using it.
				</span>
			</div>
		{/if}

		<div class="qki-row">
			<span class="qki-label">Fingerprint</span>
			{#if pending.fingerprint}
				<span class="qki-fp mono">{pending.fingerprint}</span>
			{:else}
				<span class="qki-fp-missing">
					<Icon name="alert-triangle" size={12} />
					none given by the QR — this key will sign by file upload/download instead
				</span>
			{/if}
		</div>
		{#if pending.path}
			<div class="qki-row">
				<span class="qki-label">Path</span>
				<span class="mono">{pending.path}</span>
			</div>
		{/if}
		<div class="qki-row qki-xpub-row">
			<span class="qki-label">Public key</span>
			<CopyText value={pending.xpub} truncate={14} />
		</div>

		<p class="hint">
			Compare the fingerprint above against what {vaultMode === 'collaborative' ? 'the' : 'your'} device
			shows on its own screen — a match proves this QR really came from that device.
		</p>

		{#if duplicateOf}
			<div class="form-error" role="alert">
				This is the same key as <strong>{duplicateOf.name}</strong> — every cosigner needs a
				different device or seed. Rescan a different key.
			</div>
		{/if}

		<div class="qki-actions">
			<button type="button" class="btn btn-primary btn-sm" onclick={accept} disabled={!!duplicateOf}>
				<Icon name="check" size={13} />
				This matches my device — add it
			</button>
			<button type="button" class="btn btn-ghost btn-sm" onclick={rescan}>Rescan</button>
		</div>
	</div>
{:else}
	<QrScanner
		mode="animated"
		codec="bcur-key"
		onresult={handleResult}
		deviceLabel="the device"
		forceNoCamera={cameraDisabled}
	/>
	{#if scanError}
		<div class="form-error" role="alert">{scanError}</div>
	{/if}
{/if}

<style>
	.qki-confirm {
		display: flex;
		flex-direction: column;
		gap: 10px;
		padding: 14px;
		background: var(--bg);
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-control);
	}

	.qki-title {
		display: inline-flex;
		align-items: center;
		gap: 7px;
		font-size: 13px;
		font-weight: 600;
		color: var(--text);
	}

	.qki-convert-note {
		display: flex;
		align-items: flex-start;
		gap: 8px;
		padding: 10px 12px;
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-control);
		background: var(--surface-elevated);
		color: var(--text-secondary);
		font-size: 12.5px;
		line-height: 1.6;
	}

	.qki-convert-note :global(svg) {
		flex-shrink: 0;
		margin-top: 2px;
		color: var(--text-muted);
	}

	.qki-row {
		display: flex;
		align-items: center;
		gap: 10px;
		font-size: 13px;
	}

	.qki-label {
		width: 80px;
		flex-shrink: 0;
		color: var(--text-muted);
		font-size: 12px;
	}

	/* The fingerprint is THE thing to eyeball-match against the device screen —
	   render it larger/bolder than any other field here (Caravan never shows
	   it back at all; this is the explicit fix). */
	.qki-fp {
		font-size: 16px;
		font-weight: 600;
		letter-spacing: 0.02em;
		color: var(--text);
	}

	.qki-fp-missing {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		font-size: 12px;
		color: var(--text-muted);
	}

	.qki-xpub-row {
		align-items: flex-start;
	}

	.qki-actions {
		display: flex;
		align-items: center;
		gap: 10px;
	}
</style>
