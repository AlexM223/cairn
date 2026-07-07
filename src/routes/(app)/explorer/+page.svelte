<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import { invalidate } from '$app/navigation';
	import { onNewBlock } from '$lib/liveBlocks';
	import Icon from '$lib/components/Icon.svelte';
	import HowItWorks from '$lib/components/HowItWorks.svelte';
	import GroveField from '$lib/components/heartwood/GroveField.svelte';
	import EyebrowBreadcrumb from '$lib/components/heartwood/EyebrowBreadcrumb.svelte';
	import ChainStrip from '$lib/components/heartwood/ChainStrip.svelte';
	import RingStub from '$lib/components/heartwood/RingStub.svelte';
	import { formatNumber, formatBytes, timeAgo, truncateMiddle } from '$lib/format';
	import type { SearchResult } from '$lib/types';

	let { data } = $props();

	// The chain data (blocks + mempool + tip) is STREAMED from the server
	// (cairn-ybsv): the page paints instantly with skeletons, then fills in when
	// Electrum answers. On invalidate, the previous data stays visible until the
	// fresh promise resolves — no skeleton flash on refresh.
	type ChainData = Awaited<(typeof data)['chain']>;
	let chain = $state<ChainData | null>(null);
	let refetchedForHeight: number | null = null;
	$effect(() => {
		const promise = data.chain;
		let stale = false;
		void promise.then((snap) => {
			if (stale) return;
			chain = snap;
			// A block arrived while this data was in flight — refresh once more.
			if (
				lastSeenHeight !== null &&
				snap.tipHeight !== null &&
				lastSeenHeight > snap.tipHeight &&
				refetchedForHeight !== lastSeenHeight
			) {
				refetchedForHeight = lastSeenHeight;
				void invalidate('cairn:chain');
			}
		});
		return () => {
			stale = true;
		};
	});
	const loading = $derived(chain === null);
	const blocks = $derived(chain?.blocks ?? []);
	const mempool = $derived(chain?.mempool ?? null);
	const chainError = $derived(chain?.chainError ?? null);
	const tipHeight = $derived(chain?.tipHeight ?? null);

	// The chain strip dataset (real difficulty-epoch boundaries) streams in
	// separately — the strip area holds a quiet placeholder until it lands and
	// stays hidden if the pipeline has no data (unreachable backend).
	type StripData = Awaited<(typeof data)['strip']>;
	let strip = $state<StripData>(null);
	$effect(() => {
		const promise = data.strip;
		let stale = false;
		void promise.then((s) => {
			if (!stale && s) strip = s;
		});
		return () => {
			stale = true;
		};
	});

	// Live new-block updates: refresh only the chain snapshot.
	let lastSeenHeight: number | null = null;
	onMount(() => {
		const offBlock = onNewBlock((height) => {
			if (lastSeenHeight !== null && height <= lastSeenHeight) return;
			const first = lastSeenHeight === null;
			lastSeenHeight = height;
			if (chain !== null && chain.tipHeight !== null) {
				// SSE replays the current tip on connect — ignore what we already show.
				if (height <= chain.tipHeight) return;
				// Optimistic tip (cairn-9vav): reflect the new height immediately;
				// the block list refreshes in the background via the invalidate.
				chain = { ...chain, tipHeight: height };
				void invalidate('cairn:chain');
			} else if (!first) {
				void invalidate('cairn:chain');
			}
		});
		return () => {
			offBlock();
			clearTimeout(liveTimer);
			liveAbort?.abort();
		};
	});

	// ---- hero sub-line (5e): forming ring · next-ring fee · mempool · difficulty ----

	const EPOCH = 2016;
	const forming = $derived.by(() => {
		if (tipHeight === null) return null;
		const epoch = Math.floor(tipHeight / EPOCH);
		return { ring: epoch + 1, into: tipHeight - epoch * EPOCH };
	});
	const nextFee = $derived(chain?.fees ? Math.round(chain.fees.fastest) : null);
	const mempoolVMb = $derived(mempool ? mempool.vsize / 1e6 : null);
	const diffLine = $derived.by(() => {
		const d = chain?.difficulty;
		if (!d || d.projectedChangePercent === null) return null;
		const pct = d.projectedChangePercent;
		const days =
			d.estimatedRetargetDate !== null
				? Math.max(1, Math.round((d.estimatedRetargetDate - Date.now() / 1000) / 86_400))
				: null;
		return { text: `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`, days };
	});

	// Dashed pending row: the projected next block when the backend offers it,
	// else a rough sketch from the mempool summary.
	const pending = $derived.by(() => {
		if (data.before !== null) return null;
		const nb = chain?.nextBlock;
		if (nb) {
			return {
				meta: `projected next · ${nb.feeRange[0]} sat/vB floor`,
				txs: `~${formatNumber(nb.nTx)} tx`,
				size: formatBytes(nb.vsize)
			};
		}
		if (mempool && mempool.txCount > 0) {
			return {
				meta: nextFee !== null ? `no rings yet · ≈ ${nextFee} sat/vB to make it` : 'no rings yet',
				txs: `${formatNumber(mempool.txCount)} tx waiting`,
				size: formatBytes(Math.min(mempool.vsize, 1_000_000))
			};
		}
		return null;
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

	const lastHeight = $derived(blocks.at(-1)?.height ?? null);
	const firstHeight = $derived(blocks[0]?.height ?? null);

	// Older page ends just below the last block currently shown.
	const olderUrl = $derived(
		lastHeight !== null && lastHeight > 0 ? pageUrl(lastHeight) : null
	);
	// Newer page ends 15 blocks above the first block currently shown.
	const newerUrl = $derived.by(() => {
		if (data.before === null || firstHeight === null) return null;
		const newerBefore = firstHeight + 16;
		const tip = chain?.tipHeight ?? null;
		if (tip !== null && newerBefore > tip) return pageUrl(null);
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
	<title>Explorer — Heartwood</title>
</svelte:head>

<div class="explorer">
	<GroveField volume="present" />
	<div class="body">
		<!-- ================================================== eyebrow + search -->
		<div class="top-row fade-in">
			<EyebrowBreadcrumb path={['The timechain']} />
			<form method="GET" action="/explorer" class="search" role="search" onsubmit={hideLive}>
				<span class="search-icon"><Icon name="search" size={16} /></span>
				<input
					class="search-input"
					type="search"
					name="q"
					value={data.q}
					placeholder="Block, transaction, or address"
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
		</div>

		{#if data.search}
			{#if data.search.redirect && DETECTED[data.search.type]}
				<div class="detected fade-in">
					<Icon name="check" size={15} />
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
				<div class="no-results fade-in">
					<Icon name="info" size={15} />
					<span>
						Couldn't classify <span class="mono">“{truncateMiddle(data.search.query, 14, 10)}”</span>
						— searches match a block height (like <a href="/explorer?q=800000">800000</a>), a
						64-character block hash or txid, or an address (1…, 3…, bc1…).
					</span>
				</div>
			{/if}
		{:else if recent.length > 0 && !liveLoading && !liveResult}
			<!-- Recent is the empty-box history shortcut; once the user is typing, the
			     live-suggestion dropdown takes over the same space, so hide Recent to
			     avoid the two overlapping. -->
			<div class="recent fade-in">
				<span class="hint">Recent:</span>
				{#each recent as r (r.q)}
					<a href={r.redirect} class="recent-chip mono" title={r.q}>
						{r.type === 'block-height' ? `#${formatNumber(Number(r.q))}` : truncateMiddle(r.q, 8, 6)}
					</a>
				{/each}
				<button
					class="clear-recent"
					onclick={clearRecent}
					title="Clear recent searches"
					aria-label="Clear recent searches"
				>
					<Icon name="x" size={12} />
				</button>
			</div>
		{/if}

		{#if chainError}
			<div class="form-error chain-error fade-in" role="alert">
				<Icon name="alert-triangle" size={16} />
				<span>Can't reach chain data sources — {chainError}</span>
				<a href={page.url.pathname + page.url.search} class="retry">Retry</a>
			</div>
		{/if}

		<!-- ============================================================ hero -->
		<header class="hero fade-in">
			<div class="hero-row">
				{#if tipHeight !== null}
					<span class="hero-number hero-height">{formatNumber(tipHeight)}</span>
				{:else}
					<span class="hero-number hero-height skeleton">000,000</span>
				{/if}
				<span class="hero-sub">blocks · not one removed</span>
			</div>
			<div class="live-line tabular">
				{#if forming}
					<span>
						ring {formatNumber(forming.ring)} forming — {formatNumber(forming.into)} of 2,016
					</span>
				{/if}
				{#if nextFee !== null}
					<span class="dot" aria-hidden="true">·</span>
					<span>next ring ≈ <span class="fee">{nextFee} sat/vB</span></span>
				{/if}
				{#if mempoolVMb !== null}
					<span class="dot desk" aria-hidden="true">·</span>
					<a href="/explorer/mempool" class="line-link desk">
						mempool {mempoolVMb >= 10 ? Math.round(mempoolVMb) : mempoolVMb.toFixed(1)} vMB
					</a>
				{/if}
				{#if diffLine}
					<span class="dot desk" aria-hidden="true">·</span>
					<a href="/explorer/difficulty" class="line-link desk">
						difficulty {diffLine.text}{diffLine.days !== null
							? ` in ≈ ${diffLine.days} day${diffLine.days === 1 ? '' : 's'}`
							: ''}
					</a>
				{/if}
			</div>
		</header>

		<!-- ================================================== the chain strip -->
		{#if strip}
			<div class="strip-zone fade-in">
				<div class="strip-desktop">
					<ChainStrip epochs={strip.epochs} height={120} />
					<div class="strip-caption">
						<span>2009 · genesis</span>
						<span class="cap-mid">
							{formatNumber(strip.epochCount)} rings — one per difficulty epoch · widths to scale
						</span>
						<span class="cap-now">now</span>
					</div>
				</div>
				<div class="strip-mobile">
					<ChainStrip epochs={strip.epochs} height={68} />
					<div class="strip-caption">
						<span>2009</span>
						<span class="cap-mid">
							{formatNumber(strip.epochCount)} rings · {Math.max(
								1,
								new Date().getFullYear() - 2009
							)} years
						</span>
						<span class="cap-now">now</span>
					</div>
				</div>
			</div>
		{/if}

		<!-- ==================================================== latest rings -->
		<section class="rings">
			<div class="rings-head fade-in">
				<span class="rings-title">
					{data.before !== null ? `Rings below ${formatNumber(data.before)}` : 'Latest rings'}
				</span>
				<a href="/explorer/mempool" class="mempool-link">Mempool →</a>
			</div>

			{#if loading}
				<div aria-busy="true" aria-label="Loading blocks">
					{#each [0, 1, 2, 3, 4, 5, 6] as i (i)}
						<div class="ring-row">
							<span class="skeleton sk-stub"></span>
							<span class="row-height skeleton">000,000</span>
							<span class="row-meta skeleton">00 minutes ago · Miner</span>
							<span class="row-txs skeleton">0,000 tx</span>
							<span class="row-size skeleton">0.0 MB</span>
						</div>
					{/each}
				</div>
			{:else if blocks.length === 0}
				<div class="empty-state">
					<span class="empty-title">No rings to show</span>
					<span>
						{chainError ? 'Chain data is unavailable right now.' : 'Nothing found at this height range.'}
					</span>
				</div>
			{:else}
				{#each blocks as block, i (block.hash)}
					<a href="/explorer/block/{block.height}" class="ring-row link">
						<RingStub
							state={i === 0 && data.before === null && block.height === tipHeight
								? 'tip'
								: 'past'}
							size={17}
						/>
						<span
							class="row-height tabular"
							class:tip={i === 0 && data.before === null && block.height === tipHeight}
						>
							{formatNumber(block.height)}
						</span>
						<span class="row-meta">
							{timeAgo(block.time)}{block.miner ? ` · ${block.miner}` : ''}
						</span>
						<span class="row-txs tabular">{formatNumber(block.txCount)} tx</span>
						<span class="row-size tabular">{formatBytes(block.size)}</span>
					</a>
				{/each}
				{#if pending}
					<div class="ring-row pending-row">
						<RingStub state="pending" size={17} />
						<span class="row-height pending-label">pending</span>
						<span class="row-meta">{pending.meta}</span>
						<span class="row-txs tabular">{pending.txs}</span>
						<span class="row-size tabular">{pending.size}</span>
					</div>
				{/if}
			{/if}

			{#if newerUrl || (olderUrl && blocks.length > 0)}
				<div class="pager">
					{#if newerUrl}
						<a href={newerUrl} class="btn btn-secondary btn-sm">
							<Icon name="chevron-left" size={14} /> Newer
						</a>
					{:else}
						<span></span>
					{/if}
					{#if olderUrl && blocks.length > 0}
						<a href={olderUrl} class="btn btn-secondary btn-sm">
							Older rings <Icon name="chevron-right" size={14} />
						</a>
					{/if}
				</div>
			{/if}
		</section>

		<!-- mobile network footer (8f) -->
		{#if mempool || diffLine}
			<div class="net-footer">
				<span>
					{#if mempool}
						mempool {mempoolVMb !== null && mempoolVMb >= 10
							? Math.round(mempoolVMb)
							: (mempoolVMb ?? 0).toFixed(1)} vMB · {formatNumber(mempool.txCount)} tx
					{/if}
				</span>
				<span>
					{#if diffLine}
						difficulty {diffLine.text}{diffLine.days !== null ? ` · ≈ ${diffLine.days} d` : ''}
					{/if}
				</span>
			</div>
		{/if}

		<div class="explain">
			<HowItWorks id="explorer">
				<p>
					<strong>The blockchain is a public ledger anyone can inspect</strong> — this explorer is
					your window into it. Every ~10 minutes a new block of transactions is added; the list
					above shows the newest ones. Click anything: blocks contain transactions, transactions
					move coins between addresses, and every hop is a link.
				</p>
				<p>
					The search box understands block heights (800000), block hashes, transaction IDs, and
					addresses — paste anything and Heartwood works out what it is.
				</p>
			</HowItWorks>
		</div>
	</div>
</div>

<style>
	/* Grove field bleeds to the content-column edges (negative margins undo the
	   shell's <main> padding); content floats above it. */
	.explorer {
		position: relative;
		margin: -54px -52px -44px;
		padding: 54px 52px 44px;
		min-height: calc(100vh - 98px);
	}

	.body {
		position: relative;
		z-index: 1;
	}

	/* --- eyebrow + search pill --- */
	.top-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 18px;
	}

	.search {
		position: relative;
		display: flex;
		align-items: center;
		width: 400px;
		max-width: 100%;
		height: 44px;
		background: rgba(255, 255, 255, 0.02);
		border: 1px solid var(--hairline);
		border-radius: 22px;
		padding: 0 20px;
		gap: 12px;
		transition: border-color 120ms var(--ease), box-shadow 120ms var(--ease);
	}

	.search:focus-within {
		border-color: var(--accent);
		box-shadow: 0 0 0 3px rgba(232, 147, 90, 0.12);
	}

	.search-icon {
		display: flex;
		color: var(--text-faint);
		flex-shrink: 0;
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
		background: #17120f;
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

	/* --- search result / recent (hairline grammar, no cards) --- */
	.detected,
	.no-results {
		display: flex;
		align-items: center;
		gap: 12px;
		flex-wrap: wrap;
		margin-top: 14px;
		padding-bottom: 12px;
		border-bottom: 1px solid var(--hairline);
		font-size: 13.5px;
	}

	.detected {
		color: var(--sage);
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

	.no-results {
		color: var(--text-secondary);
	}

	.recent {
		display: flex;
		align-items: center;
		gap: 8px;
		flex-wrap: wrap;
		margin-top: 12px;
	}

	.recent-chip {
		font-size: 12px;
		padding: 3px 10px;
		background: rgba(255, 255, 255, 0.02);
		border: 1px solid var(--hairline);
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
		color: var(--text-muted);
		cursor: pointer;
	}

	.clear-recent:hover {
		color: var(--attention);
		background: var(--attention-muted);
	}

	.chain-error {
		display: flex;
		align-items: center;
		gap: 10px;
		margin-top: 14px;
	}

	.chain-error .retry {
		margin-left: auto;
		color: inherit;
		text-decoration: underline;
		white-space: nowrap;
	}

	/* --- hero --- */
	.hero {
		margin-top: 18px;
	}

	.hero-row {
		display: flex;
		align-items: baseline;
		gap: 14px;
		flex-wrap: wrap;
	}

	.hero-height {
		font-size: 86px;
		line-height: 0.92;
		color: var(--text-hero);
	}

	.hero-height.skeleton {
		color: transparent;
	}

	.hero-sub {
		font-size: 15px;
		color: var(--text-secondary);
	}

	.live-line {
		display: flex;
		align-items: baseline;
		gap: 8px;
		flex-wrap: wrap;
		margin-top: 16px;
		font-size: 15px;
		color: var(--text-secondary);
	}

	.live-line .fee {
		color: var(--accent-bright);
	}

	.live-line .dot {
		color: var(--text-faint);
	}

	.line-link {
		color: var(--text-secondary);
	}

	.line-link:hover {
		color: var(--accent);
	}

	/* --- chain strip --- */
	.strip-zone {
		margin-top: 40px;
	}

	.strip-mobile {
		display: none;
	}

	.strip-caption {
		display: flex;
		justify-content: space-between;
		gap: 10px;
		margin-top: 10px;
		font-size: 11.5px;
		color: var(--eyebrow-path);
	}

	.cap-mid {
		color: var(--text-muted);
		text-align: center;
	}

	.cap-now {
		color: #b39a88;
	}

	/* --- latest rings --- */
	.rings {
		margin-top: 40px;
	}

	.rings-head {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 12px;
	}

	.rings-title {
		font-size: 17px;
		font-weight: 600;
		color: var(--text);
		letter-spacing: -0.01em;
	}

	.mempool-link {
		font-size: 13px;
		font-weight: 500;
		color: var(--accent);
		white-space: nowrap;
	}

	.ring-row {
		display: flex;
		align-items: center;
		gap: 16px;
		padding: 14px 0;
		border-bottom: 1px solid var(--hairline);
		color: inherit;
	}

	.ring-row.link:hover .row-height {
		color: var(--accent-bright);
	}

	.ring-row:last-of-type {
		border-bottom: none;
	}

	.sk-stub {
		width: 17px;
		height: 17px;
		border-radius: 50%;
		flex-shrink: 0;
	}

	.row-height {
		width: 110px;
		flex-shrink: 0;
		font-family: var(--font-serif);
		font-weight: 600;
		font-size: 16px;
		/* Spec "text/value" tone #CBBFB3 — no token exists for it. */
		color: #cbbfb3;
		transition: color 120ms var(--ease);
	}

	.row-height.tip {
		color: var(--accent-bright);
	}

	.pending-label {
		font-family: var(--font-ui);
		font-weight: 500;
		font-size: 13px;
		color: var(--eyebrow-path);
	}

	.row-meta {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: 12.5px;
		color: var(--text-faint);
	}

	.row-txs {
		font-size: 13px;
		color: #cbbfb3;
		white-space: nowrap;
	}

	.pending-row .row-txs {
		color: var(--text-muted);
	}

	.row-size {
		width: 80px;
		flex-shrink: 0;
		text-align: right;
		font-size: 13px;
		color: var(--text-muted);
	}

	.pager {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding-top: 16px;
	}

	/* --- mobile network footer (8f) --- */
	.net-footer {
		display: none;
	}

	.explain {
		margin-top: 40px;
	}

	/* ================================================ mobile (8f, ≤900px) */
	@media (max-width: 900px) {
		.explorer {
			margin: -20px -18px -48px;
			padding: 20px 18px 48px;
			min-height: 0;
		}

		/* Mobile top bar already carries the search icon; the pill goes
		   full-width under the eyebrow instead of beside it. */
		.top-row {
			flex-direction: column;
			align-items: stretch;
			gap: 12px;
		}

		.search {
			width: 100%;
			height: 40px;
		}

		.hero {
			margin-top: 20px;
			text-align: center;
		}

		.hero-row {
			flex-direction: column;
			align-items: center;
			gap: 8px;
		}

		.hero-height {
			font-size: 42px;
			line-height: 1;
			letter-spacing: -0.01em;
		}

		.hero-sub {
			font-size: 11.5px;
		}

		.live-line {
			justify-content: center;
			margin-top: 8px;
			font-size: 11.5px;
		}

		/* Mobile keeps the short sub-line; mempool + difficulty move to the
		   network footer per 8f. */
		.live-line .desk {
			display: none;
		}

		.strip-zone {
			margin-top: 20px;
		}

		.strip-desktop {
			display: none;
		}

		.strip-mobile {
			display: block;
		}

		.strip-caption {
			margin-top: 7px;
			font-size: 9.5px;
		}

		.rings {
			margin-top: 22px;
		}

		.rings-title {
			font-size: 14.5px;
		}

		.ring-row {
			gap: 11px;
			padding: 11px 0;
		}

		.row-height {
			width: 76px;
			font-size: 13.5px;
		}

		.row-meta {
			font-size: 10.5px;
		}

		.row-txs {
			font-size: 10.5px;
		}

		.row-size {
			display: none;
		}

		.net-footer {
			display: flex;
			justify-content: space-between;
			gap: 10px;
			margin-top: 26px;
			padding-top: 12px;
			border-top: 1px solid var(--hairline);
			font-size: 10.5px;
			color: var(--eyebrow-path);
		}
	}
</style>
