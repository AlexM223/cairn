<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import { invalidate } from '$app/navigation';
	import { onNewBlock } from '$lib/liveBlocks';
	import Icon from '$lib/components/Icon.svelte';
	import HowItWorks from '$lib/components/HowItWorks.svelte';
	import ExplorerNav from '$lib/components/ExplorerNav.svelte';
	import { formatNumber, formatBtc, formatBytes, timeAgo, formatDateTime, formatFeeRate, truncateMiddle } from '$lib/format';
	import type { SearchResult } from '$lib/types';

	let { data } = $props();

	// Live new-block updates: refresh only the chain snapshot.
	let lastSeenHeight: number | null = null;
	onMount(() => {
		lastSeenHeight = data.tipHeight;
		const offBlock = onNewBlock((height) => {
			if (lastSeenHeight !== null && height === lastSeenHeight) return;
			lastSeenHeight = height;
			invalidate('cairn:chain');
		});
		return () => {
			offBlock();
			clearTimeout(liveTimer);
			liveAbort?.abort();
		};
	});

	// ---- search-as-you-type: debounced live classification of the query ----
	//
	// Enter still submits the GET form exactly as before; this only offers a
	// direct link once /api/search recognizes what's being typed.

	let liveResult = $state<SearchResult | null>(null);
	let liveLoading = $state(false);
	let liveTimer: ReturnType<typeof setTimeout> | undefined;
	let liveAbort: AbortController | null = null;
	let suggestionEl = $state<HTMLAnchorElement | null>(null);

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

	// ---- search detection + per-user recent searches (kept on this device) ----

	const DETECTED: Record<string, { label: string; verb: string }> = {
		'block-height': { label: 'a block height', verb: 'View block' },
		'block-hash': { label: 'a block hash', verb: 'View block' },
		tx: { label: 'a transaction ID', verb: 'View transaction' },
		address: { label: 'a Bitcoin address', verb: 'View address' }
	};

	interface RecentSearch {
		q: string;
		type: string;
		redirect: string;
	}

	const recentKey = $derived(`cairn.recent-searches.${page.data.user?.id ?? 'anon'}`);
	let recent = $state<RecentSearch[]>([]);

	$effect(() => {
		try {
			recent = JSON.parse(localStorage.getItem(recentKey) ?? '[]');
		} catch {
			recent = [];
		}
	});

	// Remember every successfully classified search, newest first, capped at 6.
	$effect(() => {
		const s = data.search;
		if (!s || !s.redirect) return;
		const entry: RecentSearch = { q: s.query, type: s.type, redirect: s.redirect };
		const next = [entry, ...recent.filter((r) => r.q !== entry.q)].slice(0, 6);
		if (JSON.stringify(next) !== JSON.stringify(recent)) {
			recent = next;
			localStorage.setItem(recentKey, JSON.stringify(next));
		}
	});

	function clearRecent() {
		recent = [];
		localStorage.removeItem(recentKey);
	}

	const lastHeight = $derived(data.blocks.at(-1)?.height ?? null);
	const firstHeight = $derived(data.blocks[0]?.height ?? null);

	// Older page ends just below the last block currently shown.
	const olderUrl = $derived(
		lastHeight !== null && lastHeight > 0 ? pageUrl(lastHeight) : null
	);
	// Newer page ends 15 blocks above the first block currently shown.
	const newerUrl = $derived.by(() => {
		if (data.before === null || firstHeight === null) return null;
		const newerBefore = firstHeight + 16;
		if (data.tipHeight !== null && newerBefore > data.tipHeight) return pageUrl(null);
		return pageUrl(newerBefore);
	});

	function pageUrl(before: number | null): string {
		const params = new URLSearchParams();
		if (data.q) params.set('q', data.q);
		if (before !== null) params.set('before', String(before));
		const s = params.toString();
		return s ? `/explorer?${s}` : '/explorer';
	}
</script>

<svelte:head>
	<title>Explorer — Cairn</title>
</svelte:head>

<div class="head fade-in">
	<span class="overline">Explorer</span>
	<h1 class="page-title">Blocks, transactions &amp; addresses</h1>
</div>

<ExplorerNav active="overview" />

<HowItWorks id="explorer">
	<p>
		<strong>The blockchain is a public ledger anyone can inspect</strong> — this explorer is
		your window into it. Every ~10 minutes a new block of transactions is added; the list
		below shows the newest ones. Click anything: blocks contain transactions, transactions
		move coins between addresses, and every hop is a link.
	</p>
	<p>
		The search box understands block heights (800000), block hashes, transaction IDs, and
		addresses — paste anything and Cairn works out what it is.
	</p>
</HowItWorks>

<form method="GET" action="/explorer" class="search fade-in" role="search" onsubmit={hideLive}>
	<div class="search-box">
		<span class="search-icon"><Icon name="search" size={17} /></span>
		<input
			class="input search-input"
			type="search"
			name="q"
			value={data.q}
			placeholder="Search by block height, block hash, txid or address"
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
	</div>
	<button class="btn btn-primary" type="submit">Search</button>
</form>

{#if data.search}
	{#if data.search.redirect && DETECTED[data.search.type]}
		<div class="detected card card-pad fade-in">
			<Icon name="check" size={16} />
			<span class="detected-text">
				Looks like <strong>{DETECTED[data.search.type].label}</strong>
			</span>
			<a href={data.search.redirect} class="btn btn-primary btn-sm">
				{DETECTED[data.search.type].verb}
				<span class="mono detected-q">
					{data.search.type === 'block-height'
						? formatNumber(Number(data.search.query))
						: truncateMiddle(data.search.query, 8, 6)}
				</span>
				<Icon name="arrow-right" size={13} />
			</a>
		</div>
	{:else}
		<div class="no-results card card-pad fade-in">
			<Icon name="info" size={16} />
			<span>
				Couldn't classify <span class="mono">“{truncateMiddle(data.search.query, 14, 10)}”</span>
				— searches match a block height (like <a href="/explorer?q=800000">800000</a>), a
				64-character block hash or txid, or an address (1…, 3…, bc1…).
			</span>
		</div>
	{/if}
{:else if recent.length > 0}
	<div class="recent fade-in">
		<span class="hint">Recent:</span>
		{#each recent as r (r.q)}
			<a href={r.redirect} class="recent-chip mono" title={r.q}>
				{r.type === 'block-height' ? `#${formatNumber(Number(r.q))}` : truncateMiddle(r.q, 8, 6)}
			</a>
		{/each}
		<button class="clear-recent" onclick={clearRecent} title="Clear recent searches">
			<Icon name="x" size={12} />
		</button>
	</div>
{/if}

{#if data.chainError}
	<div class="form-error chain-error fade-in" role="alert">
		<Icon name="alert-triangle" size={16} />
		<span>Can't reach chain data sources — {data.chainError}</span>
		<a href={page.url.pathname + page.url.search} class="retry">Retry</a>
	</div>
{/if}

<!-- Mempool strip -->
<section class="card card-pad mempool fade-in">
	<div class="mempool-stat">
		<span class="overline">Unconfirmed</span>
		<span class="mempool-value tabular">
			{data.mempool ? formatNumber(data.mempool.txCount) : '—'}
			<span class="unit">txs</span>
		</span>
	</div>
	<div class="mempool-stat">
		<span class="overline">Mempool fees</span>
		<span class="mempool-value tabular">
			{data.mempool ? formatBtc(data.mempool.totalFees) : '—'}
			<span class="unit">BTC</span>
		</span>
	</div>
	<div class="mempool-stat">
		<span class="overline">Mempool size</span>
		<span class="mempool-value tabular">
			{data.mempool ? formatBytes(data.mempool.vsize) : '—'}
		</span>
	</div>
	<a href="/explorer/mempool" class="mempool-link">
		Explore the mempool <Icon name="arrow-right" size={13} />
	</a>
</section>

<!-- Blocks -->
<section class="card fade-in">
	<div class="blocks-head">
		<Icon name="blocks" size={17} />
		<span class="card-title">
			{data.before !== null ? `Blocks below ${formatNumber(data.before)}` : 'Recent blocks'}
		</span>
	</div>
	{#if data.blocks.length === 0}
		<div class="empty-state">
			<span class="empty-title">No blocks to show</span>
			<span>{data.chainError ? 'Chain data is unavailable right now.' : 'Nothing found at this height range.'}</span>
		</div>
	{:else}
		<div class="table-wrap">
			<table class="table">
				<thead>
					<tr>
						<th>Height</th>
						<th>Mined</th>
						<th>Miner</th>
						<th class="num">Txs</th>
						<th class="num">Size</th>
						<th class="num">Fee range</th>
					</tr>
				</thead>
				<tbody>
					{#each data.blocks as block (block.hash)}
						<tr>
							<td>
								<a href="/explorer/block/{block.height}" class="block-link tabular">
									{formatNumber(block.height)}
								</a>
							</td>
							<td class="text-muted" title={formatDateTime(block.time)}>{timeAgo(block.time)}</td>
							<td>
								{#if block.miner}
									<span class="badge badge-neutral miner-badge">{block.miner}</span>
								{:else}
									<span class="text-muted">—</span>
								{/if}
							</td>
							<td class="num">{formatNumber(block.txCount)}</td>
							<td class="num text-muted">{formatBytes(block.size)}</td>
							<td class="num text-muted">
								{#if block.feeRange}
									{formatFeeRate(block.feeRange[0]).replace(' sat/vB', '')}–{formatFeeRate(block.feeRange[1])}
								{:else}
									—
								{/if}
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	{/if}
	<div class="pager">
		{#if newerUrl}
			<a href={newerUrl} class="btn btn-secondary btn-sm">
				<Icon name="chevron-left" size={14} /> Newer
			</a>
		{:else}
			<span></span>
		{/if}
		{#if olderUrl && data.blocks.length > 0}
			<a href={olderUrl} class="btn btn-secondary btn-sm">
				Older blocks <Icon name="chevron-right" size={14} />
			</a>
		{/if}
	</div>
</section>

<style>
	.head {
		display: flex;
		flex-direction: column;
		gap: 4px;
		margin-bottom: 18px;
	}

	.search {
		display: flex;
		gap: 10px;
		margin-bottom: 14px;
	}

	.search-box {
		position: relative;
		flex: 1;
		min-width: 0;
	}

	.search-icon {
		position: absolute;
		left: 12px;
		top: 50%;
		transform: translateY(-50%);
		color: var(--text-muted);
		display: flex;
	}

	.search-input {
		padding-left: 38px;
	}

	.live-spinner {
		position: absolute;
		right: 12px;
		top: 50%;
		margin-top: -8px;
	}

	.live-suggest {
		position: absolute;
		top: calc(100% + 4px);
		left: 0;
		right: 0;
		background: var(--surface-elevated, var(--surface));
		border: 1px solid var(--border);
		border-radius: var(--radius-control);
		box-shadow: 0 6px 24px rgba(0, 0, 0, 0.35);
		padding: 4px;
		z-index: 20;
	}

	.live-link {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 7px 10px;
		border-radius: calc(var(--radius-control) - 2px);
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
		padding: 7px 10px;
		font-size: 12.5px;
		color: var(--text-muted);
	}

	.miner-badge {
		white-space: nowrap;
	}

	.no-results {
		display: flex;
		align-items: center;
		gap: 10px;
		color: var(--text-secondary);
		font-size: 13.5px;
		margin-bottom: 14px;
		padding: 12px 16px;
	}

	.chain-error {
		display: flex;
		align-items: center;
		gap: 10px;
		margin-bottom: 14px;
	}

	.chain-error .retry {
		margin-left: auto;
		color: inherit;
		text-decoration: underline;
		white-space: nowrap;
	}

	.detected {
		display: flex;
		align-items: center;
		gap: 12px;
		flex-wrap: wrap;
		margin-bottom: 14px;
		color: var(--success);
	}

	.detected-text {
		color: var(--text-secondary);
		flex: 1;
	}

	.detected-text strong {
		color: var(--text);
		font-weight: 500;
	}

	.detected-q {
		font-size: 12px;
	}

	.recent {
		display: flex;
		align-items: center;
		gap: 8px;
		flex-wrap: wrap;
		margin: -6px 0 14px;
	}

	.recent-chip {
		font-size: 12px;
		padding: 3px 9px;
		background: var(--surface);
		border: 1px solid var(--border-subtle);
		border-radius: 999px;
		color: var(--text-secondary);
		transition: border-color 120ms var(--ease), color 120ms var(--ease);
	}

	.recent-chip:hover {
		border-color: var(--accent);
		color: var(--accent);
	}

	.clear-recent {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 20px;
		height: 20px;
		background: none;
		border: none;
		border-radius: 50%;
		color: var(--text-faint);
		cursor: pointer;
	}

	.clear-recent:hover {
		color: var(--error);
		background: var(--error-muted);
	}

	.mempool {
		display: flex;
		align-items: center;
		gap: 40px;
		flex-wrap: wrap;
		margin-bottom: 14px;
	}

	.mempool-link {
		margin-left: auto;
		display: inline-flex;
		align-items: center;
		gap: 5px;
		font-size: 12.5px;
	}

	.mempool-stat {
		display: flex;
		flex-direction: column;
		gap: 3px;
	}

	.mempool-value {
		font-family: var(--font-serif);
		font-size: 21px;
		font-weight: 560;
	}

	.unit {
		font-family: var(--font-ui);
		font-size: 12px;
		color: var(--text-muted);
		font-weight: 400;
	}

	.blocks-head {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 16px 20px 12px;
	}

	.block-link {
		font-weight: 500;
	}

	.pager {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 12px 16px;
		border-top: 1px solid var(--border-subtle);
	}
</style>
