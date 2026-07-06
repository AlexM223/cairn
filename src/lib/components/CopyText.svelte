<script lang="ts">
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

	async function copy() {
		if (!(await copyToClipboard(value))) return;
		copied = true;
		setTimeout(() => (copied = false), 1500);
	}

	const shown = $derived(display ?? (truncate > 0 ? truncateMiddle(value, truncate, truncate) : value));
</script>

<button class="copy-text" class:mono onclick={copy} title="Copy to clipboard">
	<span class="copy-value">{shown}</span>
	<span class="copy-icon" class:copied>
		<Icon name={copied ? 'check' : 'copy'} size={13} />
	</span>
</button>

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
