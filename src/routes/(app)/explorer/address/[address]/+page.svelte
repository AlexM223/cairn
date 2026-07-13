<script lang="ts">
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import Icon from '$lib/components/Icon.svelte';
	import Banner from '$lib/components/Banner.svelte';
	import Amount from '$lib/components/Amount.svelte';
	import CopyText from '$lib/components/CopyText.svelte';
	import Term from '$lib/components/Term.svelte';
	import HowItWorks from '$lib/components/HowItWorks.svelte';
	import GroveField from '$lib/components/heartwood/GroveField.svelte';
	import EyebrowBreadcrumb from '$lib/components/heartwood/EyebrowBreadcrumb.svelte';
	import ExplorerSearch from '$lib/components/heartwood/ExplorerSearch.svelte';
	import { addressTypeInfo } from '$lib/bitcoin';
	import {
		formatNumber,
		formatBtc,
		formatSats,
		timeAgo,
		formatDateTime,
		truncateMiddle
	} from '$lib/format';
	import type { AddressTx } from '$lib/types';

	let { data } = $props();

	// The address itself is known synchronously (from the route param), so the
	// header chrome, page title, and QR paint instantly. The address summary and
	// its transaction history are Electrum/esplora round-trips, STREAMED in after
	// first paint (cairn-2zxt.3). Neither promise rejects.
	type InfoResult = Awaited<(typeof data)['infoResult']>;
	let infoResult = $state<InfoResult | null>(null);
	$effect(() => {
		const promise = data.infoResult;
		let stale = false;
		void promise.then((r) => {
			if (!stale) infoResult = r;
		});
		return () => {
			stale = true;
		};
	});
	const infoLoading = $derived(infoResult === null);
	const info = $derived(infoResult?.info ?? null);
	const infoError = $derived(infoResult?.error ?? null);
	const notFound = $derived(infoResult?.notFound ?? false);

	type TxsResult = Awaited<(typeof data)['txsResult']>;
	let txsResult = $state<TxsResult | null>(null);
	$effect(() => {
		const promise = data.txsResult;
		let stale = false;
		void promise.then((r) => {
			if (!stale) txsResult = r;
		});
		return () => {
			stale = true;
		};
	});
	const txsLoading = $derived(txsResult === null);
	const seedTxs = $derived(txsResult?.txs ?? []);
	const txError = $derived(txsResult?.error ?? null);

	const typeInfo = $derived(info ? addressTypeInfo(info.scriptType) : null);

	// Pages loaded on the client, appended after the server-loaded first page.
	let extraTxs = $state<AddressTx[]>([]);
	let loadingMore = $state(false);
	let loadMoreError = $state<string | null>(null);
	let hasMore = $state(false);

	// Reset accumulation whenever the streamed seed changes (new address, reload,
	// or the info/txs promises resolving). Reads `info` and `seedTxs` so it
	// re-runs when either lands.
	//
	// Cursor page size varies by backend (blockstream esplora pages confirmed txs
	// 25 at a time, mempool.space 50), so we can't treat a "short" page as the
	// end. Instead: offer more while the total count says history remains, and
	// stop once a fetch brings nothing new.
	$effect(() => {
		const currentInfo = info;
		const seed = seedTxs;
		void data.address;
		extraTxs = [];
		loadingMore = false;
		loadMoreError = null;
		hasMore = currentInfo ? seed.length > 0 && currentInfo.txCount > seed.length : false;
	});

	// Full accumulated list, newest first, de-duplicated by txid (mempool txs
	// can confirm between fetches and show up again in a later page).
	const allTxs = $derived.by(() => {
		const seen = new Set<string>();
		const out: AddressTx[] = [];
		for (const tx of [...seedTxs, ...extraTxs]) {
			if (seen.has(tx.txid)) continue;
			seen.add(tx.txid);
			out.push(tx);
		}
		return out;
	});

	// Newest-first walk from the current balance yields the balance after each
	// transaction — correct even when we only have the most recent pages.
	const rows = $derived.by(() => {
		if (!info) return [];
		let running = info.confirmedBalance + info.unconfirmedBalance;
		return allTxs.map((tx) => {
			const balanceAfter = running;
			running -= tx.delta ?? 0;
			return { ...tx, balanceAfter };
		});
	});

	const haveFullHistory = $derived(info ? allTxs.length >= info.txCount : false);
	const firstSeen = $derived(
		haveFullHistory && allTxs.length > 0 ? (allTxs[allTxs.length - 1].time ?? null) : null
	);
	const lastSeen = $derived(allTxs.length > 0 ? (allTxs[0].time ?? null) : null);

	const showLoadMore = $derived(hasMore && !haveFullHistory && allTxs.length > 0);

	// Balance-over-time sparkline (cairn-6efi.9). Built ENTIRELY from data the page
	// has already loaded — the `rows` cumulative balance series above — so it adds
	// zero chain calls. `balanceAfter` is the address balance settled after each tx;
	// walking oldest→newest gives a genuine cumulative balance-over-time curve. We
	// chart confirmed txs only (mempool txs have no settled point on the timeline)
	// and honestly omit the chart when there aren't at least two points to connect.
	const SPARK_W = 320;
	const SPARK_H = 48;
	const spark = $derived.by(() => {
		if (!info) return null;
		const series = rows
			.filter((r) => r.height !== 0)
			.map((r) => r.balanceAfter)
			.reverse(); // oldest → newest
		if (series.length < 2) return null;
		const min = Math.min(...series);
		const max = Math.max(...series);
		const span = max - min || 1;
		const n = series.length;
		// Small vertical inset so the stroke isn't clipped at the extremes.
		const padY = 3;
		const usableH = SPARK_H - padY * 2;
		const pts = series.map((v, i) => {
			const x = (i / (n - 1)) * SPARK_W;
			const y = padY + (usableH - ((v - min) / span) * usableH);
			return [x, y] as const;
		});
		const line = pts.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(' ');
		const area = `0,${SPARK_H} ${line} ${SPARK_W},${SPARK_H}`;
		return {
			line,
			area,
			count: n,
			high: max,
			low: min,
			// `partial` = we only have the most recent pages, so the curve is the
			// tail of history, not the whole life of the address.
			partial: !haveFullHistory
		};
	});

	// The address is on-chain but doesn't yet have two confirmed points to plot —
	// an honest "not enough to chart" state rather than a flat or fake line.
	const sparkEmpty = $derived(!!info && info.used && spark === null);

	async function loadMore(): Promise<void> {
		if (loadingMore) return;
		// Oldest loaded tx; confirmed txs sort after mempool ones, so this is a
		// valid confirmed-page cursor for esplora.
		const last = allTxs[allTxs.length - 1];
		if (!last) return;
		loadingMore = true;
		loadMoreError = null;
		try {
			const res = await fetch(
				`/api/address/${encodeURIComponent(data.address)}?after=${last.txid}`
			);
			const body = await res.json().catch(() => null);
			if (!res.ok) {
				throw new Error(body?.error ?? `Request failed (${res.status})`);
			}
			const incoming: AddressTx[] = Array.isArray(body?.txs) ? body.txs : [];
			const seen = new Set(allTxs.map((t) => t.txid));
			const fresh = incoming.filter((t) => !seen.has(t.txid));
			extraTxs = [...extraTxs, ...fresh];
			// Nothing new means the cursor is exhausted (txCount can overshoot
			// what the chain pages return, e.g. after a mempool tx drops).
			if (fresh.length === 0) hasMore = false;
		} catch (e) {
			loadMoreError = e instanceof Error ? e.message : String(e);
		} finally {
			loadingMore = false;
		}
	}
</script>

<svelte:head>
	<title>Address {truncateMiddle(data.address, 8, 8)} — Heartwood</title>
</svelte:head>

<div class="addr-page">
	<GroveField volume="present" />
	<div class="body">
		<div class="top-row fade-in">
			<a
				href="/explorer"
				class="back"
				onclick={(e) => {
					e.preventDefault();
					goto('/explorer', { replaceState: true });
				}}
			>
				<Icon name="chevron-left" size={15} /> Explorer
			</a>
			<div class="top-search"><ExplorerSearch variant="compact" /></div>
		</div>

		<div class="head-wrap fade-in">
			<header class="head">
				<EyebrowBreadcrumb path={['Explorer']} current="Address" />
				{#if data.ownership}
					<a class="yours-badge" href={data.ownership.wallet.href}>
						<Icon name="wallet" size={15} />
						<span class="yours-text">
							This is your wallet · <strong>{data.ownership.wallet.name}</strong>{#if data.ownership.change}<span
									class="yours-sub"> · change address</span
								>{/if}
						</span>
						<Icon name="chevron-right" size={14} />
					</a>
				{/if}
				{#if info}
					<div class="hero-row">
						<Amount sats={info.confirmedBalance} size="hero" />
					</div>
					<div class="addr mono"><CopyText value={info.address} /></div>
					<div class="meta">
						{#if typeInfo}
							<Term tip={typeInfo.explanation}>
								<span class="badge badge-accent">{typeInfo.label} · {typeInfo.prefix}</span>
							</Term>
						{/if}
						{#if info.used}
							<span
								class="badge badge-success"
								title="This address appears in at least one transaction on the blockchain."
								>Used</span
							>
						{:else}
							<span
								class="badge badge-neutral"
								title="No transaction has ever touched this address. It exists only as a possibility until someone sends to it."
								>Never used</span
							>
						{/if}
						{#if firstSeen}
							<span class="meta-date" title={formatDateTime(firstSeen)}>
								first seen {timeAgo(firstSeen)}
							</span>
						{/if}
						{#if lastSeen}
							<span class="meta-date" title={formatDateTime(lastSeen)}>
								last active {timeAgo(lastSeen)}
							</span>
						{/if}
					</div>
				{:else if infoLoading}
					<div class="hero-row" aria-busy="true" aria-label="Loading address">
						<span class="hero-number hero-bal skeleton">0.00000000</span>
						<span class="hero-unit">BTC</span>
					</div>
					<div class="addr mono"><CopyText value={data.address} /></div>
					<div class="meta">
						<span class="badge skeleton">address type</span>
					</div>
				{:else}
					<!-- notFound or infoError: the address is known, its chain record isn't -->
					<div class="hero-row">
						<span class="hero-number hero-bal dim">—</span>
						<span class="hero-unit">BTC</span>
					</div>
					<div class="addr mono"><CopyText value={data.address} /></div>
					{#if notFound}
						<p class="info-note">
							No on-chain record for this address yet — it hasn't received or sent anything, or the
							backend has never seen it.
						</p>
					{:else}
						<Banner variant="error">
							Can't reach chain data sources — {infoError}.
							{#snippet actions()}
								<a href={page.url.pathname} class="retry">Retry</a>
							{/snippet}
						</Banner>
					{/if}
				{/if}
			</header>
			{#if data.qr}
				<div class="qr">
					<img src={data.qr} alt="QR code for address {data.address}" width="132" height="132" />
					<span class="hint">Scan to copy address</span>
				</div>
			{/if}
		</div>

		<!-- balance-over-time sparkline (zero extra chain calls; from loaded rows) -->
		{#if spark}
			<section class="spark fade-in" aria-label="Balance over time">
				<div class="spark-head">
					<span class="spark-title">Balance over time</span>
					<span class="spark-sub">
						{#if spark.partial}
							latest {spark.count} transactions
						{:else}
							{spark.count} transactions
						{/if}
					</span>
				</div>
				<svg
					class="spark-svg"
					viewBox="0 0 {SPARK_W} {SPARK_H}"
					preserveAspectRatio="none"
					role="img"
					aria-label="Line chart of this address's balance across its {spark.count} confirmed transactions"
				>
					<polygon class="spark-area" points={spark.area} />
					<polyline class="spark-line" points={spark.line} />
				</svg>
				<div class="spark-foot">
					<span class="spark-mark" title="lowest balance across the charted range">
						low <Amount sats={spark.low} size="inline" />
					</span>
					<span class="spark-mark" title="highest balance across the charted range">
						high <Amount sats={spark.high} size="inline" />
					</span>
				</div>
			</section>
		{:else if sparkEmpty}
			<section class="spark spark-empty fade-in" aria-label="Balance over time">
				<div class="spark-head">
					<span class="spark-title">Balance over time</span>
				</div>
				<p class="spark-empty-note">
					Not enough history to chart yet — a balance line appears once this address has at least two
					settled transactions.
				</p>
			</section>
		{/if}

		<!-- inline serif stats -->
		{#if info}
			<section class="stat-line fade-in">
				<div class="stat">
					<span class="stat-label">
						<Term
							tip="Pending change from transactions with no rings yet. It becomes part of the balance once they take their first ring."
							>Pending</Term
						>
					</span>
					<span class="stat-value tabular">
						{#if info.unconfirmedBalance === 0}
							—
						{:else}
							<Amount
								sats={info.unconfirmedBalance}
								size="inline"
								sign
								direction={info.unconfirmedBalance > 0 ? 'in' : 'out'}
							/>
						{/if}
					</span>
				</div>
				<div class="stat">
					<span class="stat-label">Transactions</span>
					<span class="stat-value tabular">{formatNumber(info.txCount)}</span>
				</div>
				{#if info.totalReceived !== null}
					<div class="stat">
						<span class="stat-label">Total received</span>
						<span class="stat-value tabular"><Amount sats={info.totalReceived} size="inline" /></span>
					</div>
				{/if}
				{#if info.totalSent !== null && info.totalSent > 0}
					<div class="stat">
						<span class="stat-label">Total sent</span>
						<span class="stat-value tabular"><Amount sats={info.totalSent} size="inline" /></span>
					</div>
				{/if}
			</section>
		{/if}

		<section class="txs">
			<div class="txs-head fade-in">
				<span class="txs-title">History</span>
				{#if info && allTxs.length > 0 && allTxs.length < info.txCount}
					<span class="txs-count">Latest {allTxs.length} of {formatNumber(info.txCount)}</span>
				{/if}
			</div>

			{#if txError}
				<Banner variant="error">Couldn't load transactions — {txError}</Banner>
			{:else if infoLoading || txsLoading}
				<div class="table-wrap" aria-busy="true" aria-label="Loading history">
					<table class="table">
						<thead>
							<tr>
								<th>Txid</th>
								<th>Time</th>
								<th class="num">Amount</th>
								<th class="num">Balance after</th>
								<th class="num">Fee</th>
							</tr>
						</thead>
						<tbody>
							{#each [0, 1, 2, 3, 4] as i (i)}
								<tr>
									<td><span class="mono skeleton">0000000000…0000000000</span></td>
									<td><span class="skeleton">00 min ago</span></td>
									<td class="num"><span class="tabular skeleton">+0.0000 BTC</span></td>
									<td class="num"><span class="tabular skeleton">0.0000 BTC</span></td>
									<td class="num"><span class="skeleton">000 sats</span></td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			{:else if !info || allTxs.length === 0}
				<div class="empty-state">
					<span class="empty-title">No transactions</span>
					<span>This address hasn't sent or received anything yet.</span>
				</div>
			{:else}
				<div class="table-wrap">
					<table class="table">
						<thead>
							<tr>
								<th>Txid</th>
								<th>Time</th>
								<th class="num">Amount</th>
								<th class="num">Balance after</th>
								<th class="num">Fee</th>
							</tr>
						</thead>
						<tbody>
							{#each rows as tx (tx.txid)}
								<tr>
									<td>
										<a href="/explorer/tx/{tx.txid}" class="mono">{truncateMiddle(tx.txid, 10, 10)}</a>
									</td>
									<td>
										{#if tx.height === 0}
											<span
												class="badge badge-warning"
												title="Waiting in the mempool — no rings yet."
												>no rings yet</span
											>
										{:else}
											<span class="text-muted" title={formatDateTime(tx.time)}>{timeAgo(tx.time)}</span>
										{/if}
									</td>
									<td class="num tabular">
										{#if tx.delta !== null}
											<Amount
												sats={tx.delta}
												size="row"
												sign
												direction={tx.delta >= 0 ? 'in' : 'out'}
											/>
										{:else}
											—
										{/if}
									</td>
									<td
										class="num tabular text-secondary"
										title="the address balance once this transaction settled"
									>
										<Amount sats={tx.balanceAfter} size="inline" />
									</td>
									<td class="num text-muted">
										{tx.fee !== null ? `${formatSats(tx.fee)} sats` : '—'}
									</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
				{#if showLoadMore || loadMoreError}
					<div class="load-more">
						{#if loadMoreError}
							<span class="hint load-more-error" role="alert">
								Couldn't load more — {loadMoreError}
							</span>
						{/if}
						<button
							type="button"
							class="btn btn-secondary btn-sm"
							onclick={loadMore}
							disabled={loadingMore}
						>
							{#if loadingMore}
								<span class="spinner"></span>
							{:else}
								<Icon name="chevron-down" size={14} />
							{/if}
							{loadMoreError ? 'Retry' : 'Load more'}
						</button>
					</div>
				{/if}
			{/if}
		</section>

		<div class="explain">
			<HowItWorks id="address">
				<p>
					<strong>An address is a destination for bitcoin</strong> — a short encoding of the
					conditions someone must satisfy (usually a signature from a private key) to spend coins
					sent to it. Addresses don't hold coins themselves; the blockchain holds
					<strong>unspent outputs</strong> locked to them, and the balance you see is their sum.
				</p>
				<p>
					Formats have evolved for efficiency: Legacy (1…), script-wrapped (3…), Native SegWit
					(bc1q…), and Taproot (bc1p…). Newer formats take less block space to spend from, which
					means lower fees. Wallets generate a fresh address for every payment, so one wallet
					typically controls many addresses.
				</p>
			</HowItWorks>
		</div>
	</div>
</div>

<style>
	.addr-page {
		position: relative;
		margin: -54px -52px -44px;
		padding: 54px 52px 44px;
		min-height: calc(100vh - 98px);
	}

	.body {
		position: relative;
		z-index: 1;
	}

	.top-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 16px;
		margin-bottom: 26px;
	}

	.top-search {
		width: 340px;
		max-width: 100%;
		flex-shrink: 1;
	}

	.back {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		font-size: 13px;
		font-weight: 500;
		color: var(--text-muted);
	}

	.back:hover {
		color: var(--accent);
	}

	.head-wrap {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 24px;
		flex-wrap: wrap;
	}

	.head {
		display: flex;
		flex-direction: column;
		gap: 0;
		min-width: 0;
		flex: 1 1 320px;
	}

	/* "This is your wallet" ownership badge — only ever shown for the viewing
	   user's own wallets (see ownership.server.ts). */
	.yours-badge {
		display: inline-flex;
		align-items: center;
		gap: 9px;
		align-self: flex-start;
		margin-top: 16px;
		padding: 8px 12px;
		border: 1px solid var(--sage);
		border-radius: var(--radius-strip);
		background: color-mix(in srgb, var(--sage) 12%, transparent);
		color: var(--text-rows);
		font-size: 13.5px;
		line-height: 1.3;
		max-width: 100%;
	}

	.yours-badge:hover {
		background: color-mix(in srgb, var(--sage) 18%, transparent);
	}

	.yours-badge :global(svg:first-child) {
		color: var(--sage);
		flex-shrink: 0;
	}

	.yours-badge :global(svg:last-child) {
		color: var(--text-muted);
		flex-shrink: 0;
	}

	.yours-text {
		min-width: 0;
		word-break: break-word;
	}

	.yours-sub {
		color: var(--text-muted);
	}

	.hero-row {
		display: flex;
		align-items: baseline;
		gap: 12px;
		margin-top: 18px;
	}

	.hero-bal {
		font-size: 52px;
		line-height: 1;
		color: var(--text-hero);
	}

	.hero-unit {
		font-family: var(--font-serif);
		font-size: 22px;
		font-weight: 600;
		color: var(--text-muted);
	}

	.addr {
		margin-top: 14px;
		font-size: 13.5px;
		color: var(--text-secondary);
		min-width: 0;
		word-break: break-all;
	}

	.meta {
		display: flex;
		align-items: center;
		gap: 8px;
		flex-wrap: wrap;
		margin-top: 12px;
	}

	.meta-date {
		font-size: 12.5px;
		color: var(--text-faint);
	}

	.qr {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 6px;
		flex-shrink: 0;
		padding: 10px;
		background: var(--bg-input);
		border-radius: var(--radius-strip);
	}

	.qr img {
		display: block;
		width: 132px;
		height: 132px;
		max-width: 100%;
		border-radius: 6px;
	}

	/* --- balance-over-time sparkline --- */
	.spark {
		margin-top: 30px;
	}

	.spark-head {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 12px;
		margin-bottom: 8px;
	}

	.spark-title {
		font-size: 11px;
		font-weight: 600;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--text-muted);
	}

	.spark-sub {
		font-size: 12px;
		color: var(--text-faint);
	}

	.spark-svg {
		display: block;
		width: 100%;
		height: 48px;
		overflow: visible;
	}

	.spark-line {
		fill: none;
		stroke: var(--sage);
		stroke-width: 1.5;
		stroke-linejoin: round;
		stroke-linecap: round;
		vector-effect: non-scaling-stroke;
	}

	.spark-area {
		fill: var(--sage-muted);
		stroke: none;
	}

	.spark-foot {
		display: flex;
		justify-content: space-between;
		gap: 12px;
		margin-top: 6px;
		font-size: 12px;
		color: var(--text-muted);
	}

	.spark-mark {
		display: inline-flex;
		align-items: baseline;
		gap: 5px;
	}

	.spark-empty-note {
		margin: 0;
		font-size: 13px;
		line-height: 1.55;
		color: var(--text-secondary);
		max-width: 48ch;
	}

	/* --- inline serif stats --- */
	.stat-line {
		display: flex;
		gap: 40px;
		flex-wrap: wrap;
		margin-top: 30px;
		padding: 18px 0;
		border-top: 1px solid var(--hairline);
		border-bottom: 1px solid var(--hairline);
	}

	.stat {
		display: flex;
		flex-direction: column;
		gap: 3px;
	}

	.stat-label {
		font-size: 11px;
		font-weight: 600;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--text-muted);
	}

	.stat-value {
		font-family: var(--font-serif);
		font-size: 20px;
		font-weight: 600;
		color: var(--text-rows);
	}

	/* --- history --- */
	.txs {
		margin-top: 34px;
	}

	.txs-head {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 12px;
		margin-bottom: 4px;
	}

	.txs-title {
		font-size: 17px;
		font-weight: 600;
		color: var(--text);
		letter-spacing: -0.01em;
	}

	.txs-count {
		font-size: 12.5px;
		color: var(--text-faint);
	}

	.hero-bal.dim {
		color: var(--text-faint);
	}

	/* Streamed not-found note under the address (info stream resolved but
	   carried no record). The reach-error case now renders via <Banner>. */
	.info-note {
		margin-top: 16px;
		font-size: 13px;
		line-height: 1.55;
		color: var(--text-secondary);
		max-width: 52ch;
	}

	.retry {
		color: inherit;
		text-decoration: underline;
		white-space: nowrap;
	}

	.load-more {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 12px;
		flex-wrap: wrap;
		padding-top: 16px;
	}

	.load-more-error {
		color: var(--attention);
	}

	.explain {
		margin-top: 40px;
	}

	@media (max-width: 900px) {
		.addr-page {
			margin: -20px -18px -48px;
			padding: 20px 18px 48px;
			min-height: 0;
		}

		.top-row {
			margin-bottom: 18px;
		}

		.top-search {
			width: 100%;
		}

		.hero-bal {
			font-size: 36px;
		}

		.hero-unit {
			font-size: 17px;
		}

		.stat-line {
			gap: 22px;
		}

		.stat-value {
			font-size: 16px;
		}
	}
</style>
