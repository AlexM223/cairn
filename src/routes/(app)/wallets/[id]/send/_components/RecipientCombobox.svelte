<!--
	Recipient input with address-book autocomplete, following the WAI-ARIA
	combobox pattern: focus stays on the input; aria-activedescendant points at
	the highlighted option in the listbox below. With no saved addresses it
	behaves as a plain text input.

	Also owns the destination field's scan/paste affordances (QR-SCAN-DESIGN.md
	Wave 3): a camera-gated Scan button opens the shared <QrScanner> in
	single-shot mode, and a Paste button reads the clipboard directly — both
	replacing the old bare "copy an (often empty) address" icon that used to
	sit here (send-affordances-progress.md).
-->
<script lang="ts">
	import { onDestroy } from 'svelte';
	import { page } from '$app/state';
	import Icon from '$lib/components/Icon.svelte';
	import QrScanner from '$lib/components/QrScanner.svelte';
	import SecureContextHelp from '$lib/components/signing/SecureContextHelp.svelte';
	import { truncateMiddle } from '$lib/format';
	import { parseBip21 } from '$lib/bip21';
	import { resolveScanFill } from '$lib/scanFill';
	import { isCameraScanAvailable, cameraScanUnavailableReason } from '$lib/hw/qrScan';
	import type { SavedAddress } from '$lib/server/addressBook';

	let {
		value = $bindable(''),
		saved,
		invalid = false,
		ondelete,
		id = 'recipient',
		ariaLabel = undefined,
		currentAmountText = '',
		onamount
	}: {
		value: string;
		saved: SavedAddress[];
		invalid?: boolean;
		/** Inline delete from the dropdown — the parent owns the list + API call. */
		ondelete: (entry: SavedAddress) => void;
		/** Unique per instance — batch sending mounts one combobox per row. */
		id?: string;
		/** Optional aria-label for the input, for call sites with no visible
		 *  `<label for>` (e.g. a batch row identified only by a heading above
		 *  it — see the multisig send page). Leave unset when a real `<label
		 *  for>` already names the field (the single-recipient "To" label). */
		ariaLabel?: string;
		/** The row's own amount-field text (whatever unit it's displayed in) —
		 *  read-only here. Used only to decide whether a scanned/pasted BIP21
		 *  amount is safe to prefill: never overwrite something already typed. */
		currentAmountText?: string;
		/** Fired with a BIP21-carried amount in SATS when a scan/paste should
		 *  prefill the amount (only ever called when currentAmountText was
		 *  empty). The parent owns the amount field and its unit conversion —
		 *  and can additionally skip it (e.g. in "Max" mode). */
		onamount?: (sats: number) => void;
	} = $props();

	const LISTBOX_ID = $derived(`${id}-listbox`);
	const optionId = (entry: SavedAddress) => `${id}-option-${entry.id}`;

	let open = $state(false);
	let activeIndex = $state(-1);
	let rootEl = $state<HTMLElement | null>(null);

	// Match on label (anywhere) or address prefix, case-insensitive. An empty
	// query shows the whole book so a focus-then-arrow flow works.
	const matches = $derived.by(() => {
		const q = value.trim().toLowerCase();
		if (q === '') return saved;
		return saved.filter(
			(e) => e.label.toLowerCase().includes(q) || e.address.toLowerCase().startsWith(q)
		);
	});

	// Keep the highlight inside the (re-filtered) list.
	$effect(() => {
		if (activeIndex >= matches.length) activeIndex = matches.length - 1;
	});

	const expanded = $derived(open && matches.length > 0);
	const activeDescendant = $derived(
		expanded && activeIndex >= 0 && matches[activeIndex]
			? optionId(matches[activeIndex])
			: undefined
	);

	function openList() {
		if (saved.length > 0) open = true;
	}

	function closeList() {
		open = false;
		activeIndex = -1;
	}

	function select(entry: SavedAddress) {
		value = entry.address;
		closeList();
	}

	function onKeydown(e: KeyboardEvent) {
		if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
			e.preventDefault();
			if (!expanded) {
				openList();
				if (matches.length > 0) activeIndex = e.key === 'ArrowDown' ? 0 : matches.length - 1;
				return;
			}
			const delta = e.key === 'ArrowDown' ? 1 : -1;
			activeIndex = (activeIndex + delta + matches.length) % matches.length;
		} else if (e.key === 'Enter') {
			if (expanded && activeIndex >= 0 && matches[activeIndex]) {
				e.preventDefault();
				select(matches[activeIndex]);
			}
		} else if (e.key === 'Escape') {
			if (open) {
				e.preventDefault();
				closeList();
			}
		} else if (e.key === 'Tab') {
			closeList();
		}
	}

	// Close when focus leaves the whole widget (input + listbox), not when it
	// merely moves between them.
	function onFocusOut(e: FocusEvent) {
		if (rootEl && e.relatedTarget instanceof Node && rootEl.contains(e.relatedTarget)) return;
		closeList();
	}

	function deleteEntry(e: MouseEvent, entry: SavedAddress) {
		e.stopPropagation();
		ondelete(entry);
	}

	// ---------------------------------------------------------- scan + paste
	// Camera gate: honors both the browser capability check AND the
	// admin-facing `qr_scan` feature flag (matches wallets/new/+page.svelte
	// and wallets/multisig/new/+page.svelte's identical gate). Computed once
	// like QrScanner.svelte's own `cameraAvailable` — these never change
	// mid-session, and the component re-runs fresh on client hydration.
	const flagEnabled = page.data.flags?.qr_scan !== false;
	const cameraAvailable = isCameraScanAvailable() && flagEnabled;
	const unavailableReason = cameraScanUnavailableReason();
	// Only point at the HTTPS origin when insecure-context is really WHY the
	// button is hidden — an admin-disabled flag isn't a secure-context problem.
	const showSecureHelp = !cameraAvailable && flagEnabled && unavailableReason === 'insecure-context';

	let scanOpen = $state(false);
	// Non-null while showing the brief post-scan confirmation (checkmark +
	// truncated address) before the field actually fills — a scan that
	// vanishes the instant it reads a code felt like a glitch in review, so
	// this holds the result on screen for a beat first.
	let scanConfirm = $state<{ address: string } | null>(null);
	let pasteError = $state<string | null>(null);
	let confirmTimer: ReturnType<typeof setTimeout> | null = null;

	function clearConfirmTimer() {
		if (confirmTimer) {
			clearTimeout(confirmTimer);
			confirmTimer = null;
		}
	}

	function toggleScan() {
		pasteError = null;
		if (scanOpen) {
			cancelScan();
			return;
		}
		closeList();
		scanConfirm = null;
		scanOpen = true;
	}

	function cancelScan() {
		clearConfirmTimer();
		scanOpen = false;
		scanConfirm = null;
	}

	// Best-effort haptic tick on a successful scan — feature-detected and
	// wrapped, since some browsers/environments throw rather than no-op.
	function vibrateShort() {
		try {
			if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
				navigator.vibrate(25);
			}
		} catch {
			/* best-effort haptic only */
		}
	}

	const CONFIRM_HOLD_MS = 900;

	function handleScanResult(rawText: string) {
		const result = resolveScanFill(rawText, currentAmountText);
		if (!result) return; // defensive — validate() below already gated this shape
		scanConfirm = { address: result.address };
		vibrateShort();
		clearConfirmTimer();
		confirmTimer = setTimeout(() => {
			value = result.address;
			if (result.amountSats !== null) onamount?.(result.amountSats);
			scanOpen = false;
			scanConfirm = null;
			confirmTimer = null;
		}, CONFIRM_HOLD_MS);
	}

	async function pasteFromClipboard() {
		pasteError = null;
		try {
			if (!navigator.clipboard?.readText) throw new Error('clipboard API unavailable');
			const text = (await navigator.clipboard.readText()).trim();
			if (!text) {
				pasteError = 'Clipboard is empty.';
				return;
			}
			const result = resolveScanFill(text, currentAmountText);
			if (result) {
				value = result.address;
				if (result.amountSats !== null) onamount?.(result.amountSats);
			} else {
				// Not a recognized address/payment — paste it verbatim anyway (a
				// plain Ctrl+V would too); the existing shape hint below the field
				// explains why it doesn't look right.
				value = text;
			}
		} catch {
			pasteError =
				"Couldn't read the clipboard — allow clipboard access, or paste into the field by hand (Ctrl+V).";
		}
	}

	onDestroy(clearConfirmTimer);
</script>

<div class="recipient-wrap">
	<div class="combo" bind:this={rootEl} onfocusout={onFocusOut}>
		<div class="combo-row">
			<input
				{id}
				class="input mono"
				placeholder="bc1q…"
				bind:value
				autocomplete="off"
				spellcheck="false"
				role="combobox"
				aria-expanded={expanded}
				aria-controls={LISTBOX_ID}
				aria-autocomplete="list"
				aria-activedescendant={activeDescendant}
				aria-invalid={invalid}
				aria-label={ariaLabel}
				onfocus={openList}
				oninput={() => {
					openList();
					activeIndex = -1;
				}}
				onkeydown={onKeydown}
			/>
			{#if cameraAvailable}
				<button
					type="button"
					class="icon-btn"
					class:active={scanOpen}
					aria-label="Scan a QR code"
					title="Scan a QR code"
					onclick={toggleScan}
				>
					<Icon name="qr" size={15} />
				</button>
			{/if}
			<button
				type="button"
				class="icon-btn"
				aria-label="Paste from clipboard"
				title="Paste from clipboard"
				onclick={() => void pasteFromClipboard()}
			>
				<Icon name="clipboard" size={15} />
			</button>
		</div>

		{#if expanded}
			<div class="listbox" id={LISTBOX_ID} role="listbox" aria-label="Saved addresses">
				{#each matches as entry, i (entry.id)}
					<!-- svelte-ignore a11y_click_events_have_key_events — combobox pattern:
					     keyboard interaction lives on the input (ArrowUp/Down + Enter via
					     aria-activedescendant); options are never focused directly. -->
					<div
						class="option"
						class:active={i === activeIndex}
						role="option"
						id={optionId(entry)}
						aria-selected={i === activeIndex}
						tabindex="-1"
						onmousedown={(e) => e.preventDefault()}
						onclick={() => select(entry)}
						onmousemove={() => (activeIndex = i)}
					>
						<span class="opt-text">
							<span class="opt-label">{entry.label}</span>
							<span class="opt-address mono">{truncateMiddle(entry.address, 14, 10)}</span>
						</span>
						<button
							type="button"
							class="opt-delete"
							tabindex="-1"
							aria-label={`Remove ${entry.label} from saved addresses`}
							title="Remove from saved addresses"
							onmousedown={(e) => {
								e.preventDefault();
								e.stopPropagation();
							}}
							onclick={(e) => deleteEntry(e, entry)}
						>
							<Icon name="x" size={13} />
						</button>
					</div>
				{/each}
			</div>
		{/if}
	</div>

	{#if pasteError}
		<p class="field-line attention">{pasteError}</p>
	{/if}

	{#if showSecureHelp}
		<SecureContextHelp what="camera scanning" />
	{/if}

	{#if scanOpen}
		<div class="scan-panel fade-in">
			<div class="scan-panel-head">
				<span class="scan-panel-title">Scan a destination QR code</span>
				<button type="button" class="link-btn" onclick={cancelScan}>Cancel</button>
			</div>
			{#if scanConfirm}
				<div class="scan-confirm" role="status">
					<Icon name="check" size={18} strokeWidth={2.5} />
					<span>Scanned <span class="mono">{truncateMiddle(scanConfirm.address, 10, 6)}</span></span>
				</div>
			{:else}
				<QrScanner
					mode="single"
					onresult={handleScanResult}
					validate={(t) => parseBip21(t) !== null}
					pasteHint={{ placeholder: 'Paste an address or payment link…' }}
				/>
			{/if}
		</div>
	{/if}
</div>

<style>
	.recipient-wrap {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.combo {
		position: relative;
	}

	.combo-row {
		display: flex;
		align-items: center;
		gap: 8px;
	}

	.combo-row .input {
		flex: 1;
		min-width: 0;
	}

	.icon-btn {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 32px;
		height: 32px;
		flex-shrink: 0;
		border: 1px solid var(--border-control);
		border-radius: var(--radius-icon-btn);
		background: transparent;
		color: var(--text-secondary);
		cursor: pointer;
		transition:
			color 120ms var(--ease),
			border-color 120ms var(--ease);
	}

	.icon-btn:hover {
		color: var(--accent);
		border-color: var(--border-ghost);
	}

	.icon-btn.active {
		color: var(--accent);
		border-color: var(--accent);
	}

	.listbox {
		position: absolute;
		top: calc(100% + 4px);
		left: 0;
		right: 0;
		z-index: 20;
		max-height: 240px;
		overflow-y: auto;
		background: var(--surface-elevated);
		border: 1px solid var(--border);
		border-radius: var(--radius-toggle);
		box-shadow: 0 8px 24px rgba(0, 0, 0, 0.25);
		padding: 4px;
	}

	.option {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		padding: 8px 10px;
		border-radius: var(--radius-icon-btn);
		cursor: pointer;
	}

	.option.active {
		background: var(--accent-muted);
	}

	.opt-text {
		display: flex;
		flex-direction: column;
		gap: 2px;
		min-width: 0;
	}

	.opt-label {
		font-size: 13px;
		font-weight: 600;
		color: var(--text);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.opt-address {
		font-size: 11.5px;
		color: var(--text-muted);
	}

	.opt-delete {
		display: flex;
		align-items: center;
		justify-content: center;
		flex-shrink: 0;
		width: 24px;
		height: 24px;
		background: none;
		border: none;
		border-radius: var(--radius-badge);
		color: var(--text-muted);
		cursor: pointer;
	}

	.opt-delete:hover {
		color: var(--error);
		background: var(--bg);
	}

	.field-line {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		font-size: 12.5px;
		line-height: 1.5;
	}

	.field-line.attention {
		color: var(--attention);
	}

	/* ---- Scan panel: expands below the row when Scan is toggled on ---- */
	.scan-panel {
		display: flex;
		flex-direction: column;
		gap: 12px;
		padding: 14px;
		background: var(--surface-elevated);
		border: 1px solid var(--border);
		border-radius: var(--radius-control, var(--radius-icon-btn));
	}

	.scan-panel-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 10px;
	}

	.scan-panel-title {
		font-size: 12.5px;
		font-weight: 600;
		color: var(--text);
	}

	.link-btn {
		background: none;
		border: none;
		padding: 0;
		color: var(--accent);
		font-family: var(--font-ui);
		font-size: 12.5px;
		cursor: pointer;
		text-decoration: underline;
		text-underline-offset: 2px;
	}

	.scan-confirm {
		display: flex;
		align-items: center;
		gap: 8px;
		color: var(--success);
		font-size: 13.5px;
		font-weight: 500;
		background: var(--success-muted);
		border-radius: var(--radius-control);
		padding: 12px 14px;
	}
</style>
