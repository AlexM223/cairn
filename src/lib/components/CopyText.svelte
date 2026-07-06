<script lang="ts">
	import { tick } from 'svelte';
	import Icon from './Icon.svelte';
	import { copyToClipboard } from '$lib/clipboard';
	import { truncateMiddle } from '$lib/format';

	let {
		value,
		display,
		truncate = 0,
		mono = true
	}: {
		value: string;
		/** Override the shown text (defaults to value, middle-truncated if `truncate` set) */
		display?: string;
		/** If > 0, middle-truncate to roughly this many chars per side */
		truncate?: number;
		mono?: boolean;
	} = $props();

	let copied = $state(false);
	let copyFailed = $state(false);
	let fullEl: HTMLElement | undefined = $state();

	async function copy() {
		if (await copyToClipboard(value)) {
			copied = true;
			setTimeout(() => (copied = false), 1500);
			return;
		}
		// Copying is blocked (no Clipboard API and execCommand refused). Never
		// leave the value hidden behind a dead button: show it in full and
		// pre-select it so the user can copy manually.
		copyFailed = true;
		await tick();
		selectFull();
	}

	function selectFull() {
		if (!fullEl) return;
		const range = document.createRange();
		range.selectNodeContents(fullEl);
		const sel = window.getSelection();
		sel?.removeAllRanges();
		sel?.addRange(range);
	}

	const shown = $derived(display ?? (truncate > 0 ? truncateMiddle(value, truncate, truncate) : value));
</script>

{#if copyFailed}
	<span class="copy-fallback" class:mono>
		<span class="copy-full" bind:this={fullEl} onclick={selectFull} role="presentation">{value}</span>
		<span class="copy-hint">Automatic copying isn't available here — tap the text to select it, then copy.</span>
	</span>
{:else}
	<button class="copy-text" class:mono onclick={copy} title="Copy to clipboard">
		<span class="copy-value">{shown}</span>
		<span class="copy-icon" class:copied>
			<Icon name={copied ? 'check' : 'copy'} size={13} />
		</span>
	</button>
{/if}

<style>
	.copy-text {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		background: none;
		border: none;
		padding: 0;
		color: inherit;
		font-size: inherit;
		cursor: pointer;
		min-width: 0;
		max-width: 100%;
	}

	.copy-value {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.copy-fallback {
		display: inline-flex;
		flex-direction: column;
		gap: 2px;
		min-width: 0;
		max-width: 100%;
	}

	.copy-full {
		/* The whole point of this state is that nothing is truncated. */
		white-space: normal;
		word-break: break-all;
		user-select: all;
		cursor: text;
	}

	.copy-hint {
		font-family: var(--font-body, inherit);
		font-size: 0.75rem;
		color: var(--text-muted);
		user-select: none;
	}

	.copy-icon {
		color: var(--text-muted);
		display: inline-flex;
		/* Always faintly visible: touch devices have no hover state, and the
		   icon is the only cue that the value is tappable. */
		opacity: 0.45;
		transition: opacity 100ms var(--ease);
	}

	.copy-icon.copied {
		color: var(--success);
		opacity: 1;
	}

	.copy-text:hover .copy-icon,
	.copy-text:focus-visible .copy-icon {
		opacity: 1;
	}

	.copy-text:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
		border-radius: 2px;
	}
</style>
