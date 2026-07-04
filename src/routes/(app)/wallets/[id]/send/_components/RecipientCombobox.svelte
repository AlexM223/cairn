<!--
	Recipient input with address-book autocomplete, following the WAI-ARIA
	combobox pattern: focus stays on the input; aria-activedescendant points at
	the highlighted option in the listbox below. With no saved addresses it
	behaves as a plain text input.
-->
<script lang="ts">
	import Icon from '$lib/components/Icon.svelte';
	import { truncateMiddle } from '$lib/format';
	import type { SavedAddress } from '$lib/server/addressBook';

	let {
		value = $bindable(''),
		saved,
		invalid = false,
		ondelete
	}: {
		value: string;
		saved: SavedAddress[];
		invalid?: boolean;
		/** Inline delete from the dropdown — the parent owns the list + API call. */
		ondelete: (entry: SavedAddress) => void;
	} = $props();

	const LISTBOX_ID = 'recipient-listbox';
	const optionId = (entry: SavedAddress) => `recipient-option-${entry.id}`;

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
</script>

<div class="combo" bind:this={rootEl} onfocusout={onFocusOut}>
	<input
		id="recipient"
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
		onfocus={openList}
		oninput={() => {
			openList();
			activeIndex = -1;
		}}
		onkeydown={onKeydown}
	/>

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

<style>
	.combo {
		position: relative;
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
		border-radius: var(--radius-control);
		box-shadow: 0 8px 24px rgba(0, 0, 0, 0.25);
		padding: 4px;
	}

	.option {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		padding: 8px 10px;
		border-radius: var(--radius-chip);
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
		border-radius: var(--radius-chip);
		color: var(--text-muted);
		cursor: pointer;
	}

	.opt-delete:hover {
		color: var(--error);
		background: var(--bg);
	}
</style>
