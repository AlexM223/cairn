<script lang="ts">
	import Icon from '$lib/components/Icon.svelte';
	import { formatNumber, truncateMiddle } from '$lib/format';
	import type { SearchResult } from '$lib/types';

	// Persistent explorer search pill (cairn-6efi.9). One component, two shapes:
	//   - hero    → centered + larger, lives on the explorer index.
	//   - compact → slim, lives in the top row of every explorer sub-page so the
	//               search bar is always at hand, not just on the index.
	// Submitting always GETs /explorer?q=<query>; the index does the authoritative
	// server-side classification (and renders the detected / not-found panels), so
	// a sub-page search that Enter-submits lands on the index with the result. The
	// live suggestion below gives the direct one-click link for the happy path.
	let {
		variant = 'compact',
		value = ''
	}: { variant?: 'hero' | 'compact'; value?: string } = $props();

	let liveResult = $state<SearchResult | null>(null);
	let liveLoading = $state(false);
	let liveTimer: ReturnType<typeof setTimeout> | undefined;
	let liveAbort: AbortController | null = null;
	let suggestionEl = $state<HTMLAnchorElement | null>(null);

	const placeholder = $derived(
		variant === 'hero'
			? 'Paste a block, transaction, or address — your node will find it'
			: 'Block, transaction, or address'
	);

	function hideLive() {
		clearTimeout(liveTimer);
		liveAbort?.abort();
		liveAbort = null;
		liveResult = null;
		liveLoading = false;
	}

	function onSearchInput(e: Event) {
		const q = (e.currentTarget as HTMLInputElement).value.trim();
		clearTimeout(liveTimer);
		if (q.length < 3) {
			hideLive();
			return;
		}
		liveTimer = setTimeout(() => classifyLive(q), 300);
	}

	async function classifyLive(q: string) {
		// The endpoint does upstream lookups — abort anything stale first.
		liveAbort?.abort();
		const ctrl = new AbortController();
		liveAbort = ctrl;
		liveLoading = true;
		try {
			const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`, {
				signal: ctrl.signal
			});
			if (!res.ok) throw new Error(`search returned ${res.status}`);
			liveResult = (await res.json()) as SearchResult;
		} catch {
			if (!ctrl.signal.aborted) liveResult = null;
		} finally {
			if (liveAbort === ctrl) {
				liveLoading = false;
				liveAbort = null;
			}
		}
	}

	function onSearchKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape') {
			hideLive();
		} else if (e.key === 'ArrowDown' && suggestionEl) {
			e.preventDefault();
			suggestionEl.focus();
		}
	}

	const liveLabel = $derived.by(() => {
		if (!liveResult || !liveResult.redirect) return null;
		switch (liveResult.type) {
			case 'block-height':
				return `Block ${formatNumber(Number(liveResult.query))}`;
			case 'block-hash':
				return `Block ${truncateMiddle(liveResult.query, 8, 6)}`;
			case 'tx':
				return `Transaction ${truncateMiddle(liveResult.query, 8, 6)}`;
			case 'address':
				return `Address ${truncateMiddle(liveResult.query, 10, 6)}`;
			default:
				return null;
		}
	});
</script>

<form
	method="GET"
	action="/explorer"
	class="search"
	class:hero={variant === 'hero'}
	role="search"
	onsubmit={hideLive}
>
	<span class="search-icon"><Icon name="search" size={variant === 'hero' ? 18 : 16} /></span>
	<input
		class="search-input"
		type="search"
		name="q"
		{value}
		{placeholder}
		autocomplete="off"
		spellcheck="false"
		aria-label="Search the blockchain"
		oninput={onSearchInput}
		onkeydown={onSearchKeydown}
	/>
	{#if liveLoading}
		<span class="spinner live-spinner" aria-hidden="true"></span>
	{/if}
	{#if liveResult}
		<div class="live-suggest">
			{#if liveResult.redirect && liveLabel}
				<a href={liveResult.redirect} class="live-link" bind:this={suggestionEl}>
					<Icon name="arrow-right" size={13} />
					<span>{liveLabel}</span>
				</a>
			{:else}
				<span class="live-unknown">keep typing — height, hash, txid, or address</span>
			{/if}
		</div>
	{/if}
</form>

<style>
	.search {
		position: relative;
		display: flex;
		align-items: center;
		width: 400px;
		max-width: 100%;
		height: 44px;
		background: var(--search-fill);
		border: 1px solid var(--hairline);
		border-radius: 22px;
		padding: 0 20px;
		gap: 12px;
		transition:
			border-color 120ms var(--ease),
			box-shadow 120ms var(--ease);
	}

	.search.hero {
		width: 560px;
		height: 54px;
		border-radius: 27px;
		padding: 0 24px;
	}

	.search:focus-within {
		border-color: var(--accent);
		box-shadow: 0 0 0 3px var(--accent-muted);
	}

	.search-icon {
		display: flex;
		color: var(--text-faint);
		flex-shrink: 0;
	}

	.search.hero .search-icon {
		color: var(--accent);
	}

	.search-input {
		flex: 1;
		min-width: 0;
		background: none;
		border: none;
		outline: none;
		color: var(--text);
		caret-color: var(--accent);
		font-family: var(--font-ui);
		font-size: 13.5px;
	}

	.search.hero .search-input {
		font-size: 15px;
	}

	.search-input::placeholder {
		color: var(--eyebrow-path);
	}

	.live-spinner {
		flex-shrink: 0;
	}

	.live-suggest {
		position: absolute;
		top: calc(100% + 6px);
		left: 0;
		right: 0;
		background: var(--surface);
		border: 1px solid var(--border-control);
		border-radius: var(--radius-status-pill);
		box-shadow: 0 10px 32px rgba(0, 0, 0, 0.45);
		padding: 4px;
		z-index: 20;
	}

	.live-link {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 8px 12px;
		border-radius: 13px;
		font-size: 13px;
		color: var(--text);
	}

	.live-link:hover,
	.live-link:focus-visible {
		background: var(--accent-muted);
		color: var(--accent);
	}

	.live-unknown {
		display: block;
		padding: 8px 12px;
		font-size: 12.5px;
		color: var(--text-muted);
	}

	@media (max-width: 900px) {
		.search,
		.search.hero {
			width: 100%;
			height: 40px;
		}
	}
</style>
