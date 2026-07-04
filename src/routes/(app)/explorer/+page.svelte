<script lang="ts">
	import { page } from '$app/state';
	import Icon from '$lib/components/Icon.svelte';
	import { formatNumber, formatBtc, formatBytes, timeAgo, formatDateTime, formatFeeRate } from '$lib/format';

	let { data } = $props();

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

<form method="GET" action="/explorer" class="search fade-in" role="search">
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
		/>
	</div>
	<button class="btn btn-primary" type="submit">Search</button>
</form>

{#if data.q}
	<div class="no-results card card-pad fade-in">
		<Icon name="info" size={16} />
		<span>No results for <span class="mono">“{data.q}”</span> — try a block height, block hash, txid or address.</span>
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

	.mempool {
		display: flex;
		gap: 40px;
		flex-wrap: wrap;
		margin-bottom: 14px;
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
