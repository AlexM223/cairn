<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import { invalidate } from '$app/navigation';
	import { onNewBlock } from '$lib/liveBlocks';
	import { triggerChainRefresh } from '$lib/chainRefresh';
	import { mempoolStats } from '$lib/live/mempoolStats.svelte';
	import { debounced } from '$lib/live/walletEvents';
	import Icon from '$lib/components/Icon.svelte';
	import Banner from '$lib/components/Banner.svelte';
	import HowItWorks from '$lib/components/HowItWorks.svelte';
	import Term from '$lib/components/Term.svelte';
	import FeeRate from '$lib/components/FeeRate.svelte';
	import GroveField from '$lib/components/heartwood/GroveField.svelte';
	import EyebrowBreadcrumb from '$lib/components/heartwood/EyebrowBreadcrumb.svelte';
	import { TIMECHAIN_TIP, RING_TIP, NO_REORG_TIP, VMB_TIP } from '$lib/termGlosses';
	import ChainStrip from '$lib/components/heartwood/ChainStrip.svelte';
	import RingStub from '$lib/components/heartwood/RingStub.svelte';
	import FormingRing from '$lib/components/heartwood/FormingRing.svelte';
	import RingBar from '$lib/components/heartwood/RingBar.svelte';
	import NodeTrustChip from '$lib/components/heartwood/NodeTrustChip.svelte';
	import {
		formatNumber,
		formatBytes,
		formatFeeRate,
		formatMovedBtc,
		timeAgo,
		truncateMiddle
	} from '$lib/format';
	import { isCompleteSearchCandidate } from '$lib/searchShape';
	import type { BlockSummary, SearchResult } from '$lib/types';

	let { data } = $props();

	// Stale-while-revalidate: the chain data renders instantly from the persisted
	// SQLite snapshot load() read (data.chain); the client refreshes it in the
	// background and invalidate('cairn:chain') re-runs load() to pick up the fresh
	// snapshot. `chain` mirrors data.chain but stays a mutable $state so a new-block
	// SSE event can optimistically bump the tip before the refetch lands. (Paging
	// into older rings — data.before set — is a live fetch, not the snapshot.)
	// Seeded from data.chain and re-synced when load() re-runs (the $effect below);
	// the initial-value capture is intended.
	// svelte-ignore state_referenced_locally
	let chain = $state(data.chain);
	$effect(() => {
		chain = data.chain;
	});

	// Background-refresh state driving the "last synced …" indicator. Paged history
	// views (data.before set) aren't SWR — no background refresh there.
	let syncing = $state(false);
	let syncFailed = $state(false);
	async function refresh(force = false) {
		if (syncing || data.before !== null) return;
		syncing = true;
		const ok = await triggerChainRefresh(force);
		syncing = false;
		syncFailed = !ok;
	}
	onMount(() => {
		void refresh();
	});

	// Paged/history view (data.before set) isn't SWR (see the comment on
	// `chain` above) — refresh() intentionally no-ops there. Without this, the
	// error banner's "Retry" button on a paged view called refresh(true),
	// which silently did nothing: a dead-end error with a button that clicked
	// but never acted (cairn-obg6). Re-running the server load via the
	// `depends('cairn:chain')` key it already registers gives paged views a
	// real retry instead.
	async function retryPaged() {
		await invalidate('cairn:chain');
	}

	const syncLabel = $derived(
		data.before !== null
			? ''
			: syncing
				? 'updating…'
				: data.lastSyncedAt
					? `synced ${timeAgo(Math.floor(data.lastSyncedAt / 1000))}`
					: ''
	);

	// Loading = no snapshot yet AND the first refresh hasn't failed. On the paged
	// history path `chain` is always populated (a live fetch), so this is false.
	const loading = $derived(chain === null && !syncFailed && data.before === null);
	const blocks = $derived(chain?.blocks ?? []);

	// Live mempool payload (docs/LIVE-UPDATES-DESIGN.md §4.2, cairn-102c): the
	// `mempool` frame carries count/vsize (plus the projection used by `upcoming`
	// below) straight off the wire on every tick — payload-driven, no fetch. Reads
	// of `mempool.txCount`/`vsize` below (hero live-line, rail, mobile net-footer,
	// the pending dashed row) all prefer the live values once a frame has landed,
	// falling back to the load-time snapshot before the first one so there's never
	// a flash of empty. `totalFees` isn't in the frame, so it always comes from
	// the snapshot.
	const live = $derived(mempoolStats.stats);
	const mempool = $derived.by(() => {
		const snap = chain?.mempool ?? null;
		if (!live || (live.count === null && live.vsizeVb === null)) return snap;
		if (!snap) return null;
		return {
			txCount: live.count ?? snap.txCount,
			vsize: live.vsizeVb ?? snap.vsize,
			totalFees: snap.totalFees
		};
	});
	const chainError = $derived(chain?.chainError ?? null);
	// Error banner: a live paged-fetch error, or the very-first snapshot refresh
	// failing before anything was ever persisted.
	const showError = $derived(chainError !== null || (chain === null && syncFailed));
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

	// ---- forming ring (T-A, cairn-6efi.2) ----
	// The next block visibly grows: --growth = min(1, secsSinceLastBlock/600),
	// ticked client-side from the tip block's timestamp (no chain call — the
	// snapshot already carries blocks[0].time). A real new block seals the ring
	// (one-shot bloom) and rolls the tip counter; both are derived from the
	// tip-height increase the SSE stream already drives (see onNewBlock below).
	const tipTime = $derived(blocks[0]?.time ?? null);
	let nowSec = $state(Math.floor(Date.now() / 1000));
	onMount(() => {
		const t = setInterval(() => (nowSec = Math.floor(Date.now() / 1000)), 5_000);
		return () => clearInterval(t);
	});
	const growth = $derived(
		tipTime !== null ? Math.min(1, Math.max(0, (nowSec - tipTime) / 600)) : 0
	);
	// Show the forming ring on the live tip view whenever we know the tip height.
	const formingVisible = $derived(data.before === null && tipHeight !== null);
	// One-shot seal/roll trigger — bumped only on a genuine new block (see below).
	let sealKey = $state(0);

	// Live new-block updates: refresh only the chain snapshot (tip view only).
	let lastSeenHeight: number | null = null;
	onMount(() => {
		const offBlock = onNewBlock((height) => {
			if (lastSeenHeight !== null && height <= lastSeenHeight) return;
			const first = lastSeenHeight === null;
			lastSeenHeight = height;
			if (chain !== null && chain.tipHeight !== null) {
				// SSE replays the current tip on connect — ignore what we already show.
				if (height <= chain.tipHeight) return;
				// A genuine new block: seal the forming ring + roll the tip counter once.
				sealKey += 1;
				// Optimistic tip (cairn-9vav): reflect the new height immediately;
				// the block list refreshes in the background via the forced refresh.
				chain = { ...chain, tipHeight: height };
				void refresh(true);
			} else if (!first) {
				void refresh(true);
			}
		});
		return () => {
			offBlock();
			clearTimeout(liveTimer);
			liveAbort?.abort();
		};
	});

	// cairn-102c: a `mempool` frame nudge means the count/vsize/projection just
	// changed — already overlaid live above (`mempool`, `upcoming`). But `nextFee`
	// below and the difficulty rail read chain.fees/chain.difficulty, heavier
	// server-recomputed fields the frame doesn't carry (docs/LIVE-UPDATES-DESIGN.md
	// §4.2) — those need a real snapshot refresh to stay current between blocks.
	// The frame can tick every 5s, so a plain trailing debounce (the mempool
	// page's own `nudgeRefresh` pattern) would refresh far too often here; add a
	// hard floor on top so this fires at most once per 30s.
	let lastMempoolNudge = 0;
	const MEMPOOL_NUDGE_MIN_MS = 30_000;
	const nudgeChainRefresh = debounced(() => {
		const now = Date.now();
		if (now - lastMempoolNudge < MEMPOOL_NUDGE_MIN_MS) return;
		lastMempoolNudge = now;
		void refresh(true);
	}, 2000);
	$effect(() => {
		if (live?.updatedAt === undefined) return; // no frame yet
		nudgeChainRefresh();
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
	// else a rough sketch from the mempool summary. The fee rate is structured
	// (not a preformatted string) so the row renders it through the shared
	// FeeRate component — glossed like every other rate on this page.
	const pending = $derived.by(() => {
		if (data.before !== null) return null;
		const nb = chain?.nextBlock;
		if (nb) {
			return {
				label: 'projected next',
				rate: nb.feeRange[0],
				rateSuffix: 'floor',
				approx: false,
				txs: `~${formatNumber(nb.nTx)} tx`,
				size: formatBytes(nb.vsize)
			};
		}
		if (mempool && mempool.txCount > 0) {
			return {
				label: 'not in a block yet',
				rate: nextFee,
				rateSuffix: 'to make it',
				approx: true,
				txs: `${formatNumber(mempool.txCount)} tx waiting`,
				size: formatBytes(Math.min(mempool.vsize, 1_000_000))
			};
		}
		return null;
	});

	// Compact "Up next" strip (cairn-pw3u): the next few projected blocks, a
	// forward-looking view — previously buried two
	// clicks deep at /explorer/mempool -> Visualize. Reuses the same
	// mempoolBlocks snapshot field the mempool page's "Projected next rings"
	// section and the /explorer/mempool/blocks treemap already read; no new
	// data pipeline. Hidden (not an error) when the backend has no projection
	// or on the paged history view.
	//
	// cairn-102c: the live `mempool` frame's own `mempoolBlocks` field is the
	// exact same MempoolBlockProjection[] shape these chips render (medianFee /
	// feeRange / nTx), so it's overlaid directly here — same payload-driven
	// idiom as the mempool page's `projected`, no invalidate needed.
	const upcoming = $derived.by(() => {
		if (data.before !== null) return null;
		const mb = live?.mempoolBlocks ?? chain?.mempoolBlocks;
		if (!mb || mb.length === 0) return null;
		return mb.slice(0, 4);
	});

	// ---- rich block rows (T-C, cairn-6efi.4) ----
	// "Yours" pip: viewer-scoped set of block heights the current user has a tx in
	// (computed server-side in load, zero chain calls). O(1) per row.
	const yoursSet = $derived(new Set(data.yoursHeights ?? []));
	// "Found here" pip (cairn-r1hca): accepted blocks this instance's own pool
	// found, newest first from the server. Keyed by hash (not height) since
	// that's what the backend already dedupes pool attribution on.
	const poolFoundSet = $derived(new Set(data.poolFoundHashes ?? []));
	// "~N BTC moved" from total_out (sats) — extracted to $lib/format as
	// formatMovedBtc so its render-guard hardening (cairn-6efi.11) is unit-tested.
	// Pool copy: "Likely X" for a coinbase-derived identification (Core path). Null
	// (nothing rendered) when no pool is known — never a wrong guess.
	function poolLabel(block: BlockSummary): string | null {
		if (block.pool?.name) return `Likely ${block.pool.name}`;
		if (block.miner) return block.miner;
		return null;
	}

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

	// A complete-length candidate (full height or 64-hex hash/txid) that the
	// backend classified as unknown is a definitive miss, not incomplete
	// input — show an honest "not found" state instead of the generic "keep
	// typing" hint, which otherwise dead-ends the live-suggestion dropdown
	// (cairn-ioeg5). Enter still submits the form to the server-rendered
	// "Couldn't classify" panel below regardless.
	const liveNotFound = $derived(
		liveResult !== null && !liveResult.redirect && isCompleteSearchCandidate(liveResult.query)
	);

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
			<EyebrowBreadcrumb path={['The timechain']} tip={TIMECHAIN_TIP} />
			<form method="GET" action="/explorer" class="search" role="search" onsubmit={hideLive}>
				<span class="search-icon"><Icon name="search" size={16} /></span>
				<input
					class="search-input"
					type="search"
					name="q"
					value={data.q}
					placeholder="Paste a block, transaction, or address — your node will find it"
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
						{:else if liveNotFound}
							<span class="live-unknown">
								We couldn't find that. Double-check the ID, or it may not have reached the network
								yet.
							</span>
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

		{#if showError && blocks.length > 0 && !data.disconnected}
			<!-- Chain source unreachable but a persisted snapshot still renders below
			     (spec §2.5 node-status): never a "can't reach the network" banner
			     beside a full block list — one quiet line, once. When the shared
			     node-trust signal also reads disconnected, the explorer layout's own
			     snapshot caption already says exactly this, so skip the duplicate. -->
			<div class="stale-note fade-in" role="status">
				Showing your last saved snapshot — this page will catch up when your node answers.
			</div>
		{:else if showError && blocks.length === 0}
			<!-- Calm, plain-language disconnected state (cairn-obg6) — no raw
			     technical error text, no alarm tone (Banner's non-error variants
			     render role="status", not "alert"): losing the chain source is
			     expected/recoverable, not a crisis. Only rendered when there is
			     genuinely nothing to show — never beside chain data (spec §2.5). -->
			<div class="chain-error fade-in">
				<Banner variant="warning">
					<span class="chain-error-text">
						<strong>Heartwood can't reach the Bitcoin network right now.</strong>
						<span class="detail">
							Your money is safe — the explorer will wake up when the connection returns.
						</span>
					</span>
					{#snippet actions()}
						<button
							type="button"
							class="retry"
							onclick={() => (data.before !== null ? retryPaged() : refresh(true))}
						>
							Retry
						</button>
						{#if data.isAdmin}
							<!-- Retry was the only action here (cairn-obg6) — admins can
							     actually fix a dead connection, so give them a direct path
							     instead of just a spinner-and-hope Retry loop. -->
							<a class="check-settings" href="/admin/settings">Check connection settings</a>
						{/if}
					{/snippet}
				</Banner>
			</div>
		{/if}

		<!-- ============================================================ hero -->
		<header class="hero fade-in">
			<NodeTrustChip trust={data.nodeTrust} />
			<div class="hero-row">
				{#if tipHeight !== null}
					<!-- Tip counter rolls once when a new block seals (cairn-6efi.2);
					     the {#key} remount restarts the CSS roll, gated to real blocks
					     (sealKey > 0) so first paint doesn't animate. -->
					{#key sealKey}
						<span class="hero-number hero-height" class:roll={sealKey > 0}>
							{formatNumber(tipHeight)}
						</span>
					{/key}
					<span class="hero-sub">
						blocks · <Term tip={NO_REORG_TIP}>every block still stands</Term>
					</span>
				{:else if loading}
					<span class="hero-number hero-height skeleton">000,000</span>
					<span class="hero-sub">blocks · every block still stands</span>
				{:else}
					<!-- Genuinely disconnected, not just loading (cairn-obg6) — a fake
					     "000,000" placeholder used to sit here indefinitely, implying
					     data that doesn't exist. A plain dash reads as "nothing to show"
					     instead of "still counting". -->
					<span class="hero-number hero-height dash" aria-hidden="true">—</span>
					<span class="hero-sub">not connected right now</span>
				{/if}
			</div>
			<div class="live-line tabular">
				{#if forming}
					<span>
						<Term tip={RING_TIP}>difficulty period</Term>
						{formatNumber(forming.ring)} · block {formatNumber(forming.into)} of 2,016
					</span>
				{/if}
				{#if nextFee !== null}
					<span class="dot" aria-hidden="true">·</span>
					<span>next block ≈ <span class="fee"><FeeRate rate={nextFee} /></span></span>
				{/if}
				{#if mempoolVMb !== null}
					<span class="dot desk" aria-hidden="true">·</span>
					<a
						href="/explorer/mempool"
						class="line-link desk"
						title="Virtual megabytes of pending transactions"
					>
						mempool · {mempoolVMb >= 10 ? Math.round(mempoolVMb) : mempoolVMb.toFixed(1)} MB waiting
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
				{#if syncLabel}
					<span class="dot desk" aria-hidden="true">·</span>
					<span class="sync-status desk" class:updating={syncing}>{syncLabel}</span>
				{/if}
			</div>
		</header>

		<!-- =================================================== up next strip -->
		{#if formingVisible || upcoming}
			<section class="upcoming fade-in" aria-label="Upcoming blocks">
				<div class="upcoming-head">
					<span class="upcoming-title">Up next</span>
					{#if upcoming}
						<a href="/explorer/mempool/blocks" class="upcoming-link">
							Full view <Icon name="arrow-right" size={13} />
						</a>
					{/if}
				</div>
				<div class="upcoming-row">
					{#if formingVisible}
						<!-- The forming ring is the HEAD of the strip (cairn-6efi.2);
						     projected blocks queue behind it. -->
						<FormingRing {growth} {nextFee} {sealKey} />
					{/if}
					{#each upcoming ?? [] as block, i (i)}
						<div class="upcoming-chip" class:next={i === 0} style:--depth={i}>
							<span class="chip-eta">{i === 0 ? 'next block' : `~${(i + 1) * 10} min`}</span>
							<span class="chip-fee tabular">{formatFeeRate(block.medianFee)}</span>
							<span class="chip-range tabular"><FeeRate range={block.feeRange} /></span>
						</div>
					{/each}
				</div>
			</section>
		{/if}

		<!-- ================================================== the chain strip -->
		{#if strip}
			<div class="strip-zone fade-in">
				<div class="strip-desktop">
					<ChainStrip epochs={strip.epochs} height={120} />
					<div class="strip-caption">
						<span>2009 · genesis</span>
						<span class="cap-mid">
							<Term tip={RING_TIP}
								>{formatNumber(strip.epochCount)} ring{strip.epochCount === 1 ? '' : 's'}</Term
							> — one per difficulty period · widths to scale
						</span>
						<span class="cap-now">now</span>
					</div>
				</div>
				<div class="strip-mobile">
					<ChainStrip epochs={strip.epochs} height={68} />
					<div class="strip-caption">
						<span>2009</span>
						<span class="cap-mid">
							<Term tip={RING_TIP}
								>{formatNumber(strip.epochCount)} ring{strip.epochCount === 1 ? '' : 's'}</Term
							> · {Math.max(1, new Date().getFullYear() - 2009)} years
						</span>
						<span class="cap-now">now</span>
					</div>
				</div>
			</div>
		{/if}

		<!-- ==================================================== latest rings -->
		<!-- Desktop (>=1160px): the recent-blocks list takes the 2/3 lane and a
		     quiet rail carries the network summary (docs/DESKTOP-LAYOUT-DESIGN.md
		     §4 Explorer home). Below that the rail is display:none and the list is
		     full-width, with the mobile net-footer carrying the same summary —
		     mobile untouched. -->
		<div class="rings-layout">
		<section class="rings">
			<div class="rings-head fade-in">
				<span class="rings-title">
					{data.before !== null ? `Blocks below ${formatNumber(data.before)}` : 'Latest blocks'}
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
					<span class="empty-title">No blocks to show</span>
					<span>
						<!-- showError already covers both this (tip-view, never-synced)
						     and the paged-history live-fetch failure — reusing it here
						     fixes a case where a disconnected backend fell through to
						     "Nothing found at this height range", technical-sounding
						     jargon that implied a bad search rather than a lost
						     connection (cairn-obg6). -->
						{showError ? 'Chain data is unavailable right now.' : 'No blocks found in this range.'}
					</span>
				</div>
			{:else}
				<!-- Pending/mempool block is the NEXT block to be mined, so it belongs at
				     the TOP of the list, above every confirmed block (cairn-lynf).
				     `pending` is already gated to the tip view (data.before === null),
				     so this never appears on paged/older history — only ever above the
				     newest confirmed block. -->
				{#if pending}
					<div class="ring-row pending-row">
						<RingStub state="pending" size={17} />
						<span class="row-headcol">
							<span class="row-height pending-label">pending</span>
						</span>
						<span class="ringbar-spacer" aria-hidden="true"></span>
						<span class="row-meta">
							{pending.label}{#if pending.rate !== null}
								· <FeeRate rate={pending.rate} approx={pending.approx} />
								{pending.rateSuffix}{/if}
						</span>
						<span class="row-txs tabular">{pending.txs}</span>
						<span class="row-size tabular">{pending.size}</span>
					</div>
				{/if}
				{#each blocks as block, i (block.hash)}
					<a href="/explorer/block/{block.height}" class="ring-row link">
						<RingStub
							state={i === 0 && data.before === null && block.height === tipHeight
								? 'tip'
								: 'past'}
							size={17}
						/>
						<span class="row-headcol">
							<span
								class="row-height tabular"
								class:tip={i === 0 && data.before === null && block.height === tipHeight}
							>
								{formatNumber(block.height)}
							</span>
							{#if poolFoundSet.has(block.hash)}
								<span class="found-pip" title="This instance's pool found this block">
									Found here
								</span>
							{/if}
							{#if yoursSet.has(block.height)}
								<span class="yours-pip" title="One of your transactions is in this block">
									Yours
								</span>
							{/if}
						</span>
						<RingBar fullness={block.fullness} medianFee={block.medianFee} width={40} />
						<span class="row-meta">
							{timeAgo(block.time)}{#if !poolFoundSet.has(block.hash) && poolLabel(block)} ·
								<span class="row-pool">{poolLabel(block)}</span>{/if}{#if block.feeRange}
								· <span class="row-detail"><FeeRate range={block.feeRange} /></span>{/if}{#if formatMovedBtc(block.total_out)}
								· <span class="row-detail">{formatMovedBtc(block.total_out)}</span>{/if}
						</span>
						<span class="row-txs tabular">
							{block.txCount ? `${formatNumber(block.txCount)} tx` : '—'}
						</span>
						<span class="row-size tabular">
							{block.size ? formatBytes(block.size) : '—'}
						</span>
					</a>
				{/each}
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
							Load older blocks <Icon name="chevron-right" size={14} />
						</a>
					{/if}
				</div>
			{/if}
		</section>

		<!-- Quiet network-summary rail (desktop only). Built from the same snapshot
		     data the hero live-line and mobile net-footer already use — no new
		     client wiring (a follow-up bead owns live mempool frames). -->
		<aside class="explorer-rail quiet-rail" aria-label="Network summary">
			{#if mempool}
				<div class="rail-block">
					<span class="rail-eyebrow">Mempool size</span>
					<span class="rail-value tabular">
						<Term tip={VMB_TIP}>
							{mempoolVMb !== null && mempoolVMb >= 10
								? Math.round(mempoolVMb)
								: (mempoolVMb ?? 0).toFixed(1)} MB
						</Term>
					</span>
					<span class="rail-sub tabular">{formatNumber(mempool.txCount)} tx waiting</span>
					<a href="/explorer/mempool" class="rail-link">Open mempool →</a>
				</div>
			{/if}
			{#if nextFee !== null}
				<div class="rail-block">
					<span class="rail-eyebrow">Next block fee</span>
					<span class="rail-value tabular"><FeeRate rate={nextFee} /></span>
				</div>
			{/if}
			{#if diffLine}
				<div class="rail-block">
					<span class="rail-eyebrow">Difficulty</span>
					<span class="rail-value tabular">{diffLine.text}</span>
					{#if diffLine.days !== null}
						<span class="rail-sub">retarget in ≈ {diffLine.days} day{diffLine.days === 1 ? '' : 's'}</span>
					{/if}
					<a href="/explorer/difficulty" class="rail-link">Difficulty history →</a>
				</div>
			{/if}
			{#if syncLabel}
				<div class="rail-block">
					<span class="rail-eyebrow">Node</span>
					<span class="rail-sub" class:updating={syncing}>{syncLabel}</span>
				</div>
			{/if}
		</aside>
		</div>

		<!-- mobile network footer (8f) -->
		{#if mempool || diffLine}
			<div class="net-footer">
				<span>
					{#if mempool}
						mempool · {mempoolVMb !== null && mempoolVMb >= 10
							? Math.round(mempoolVMb)
							: (mempoolVMb ?? 0).toFixed(1)} MB waiting · {formatNumber(mempool.txCount)} tx
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
					<strong>The blockchain is a public ledger anyone can inspect</strong>, and this explorer
					is your window into it. Every ~10 minutes miners seal a new block of transactions onto the
					end of the chain — like a tree adding a growth ring, each one is permanent and never
					removed. That's why Heartwood draws the chain as <strong>rings</strong>: every 2,016
					blocks (about two weeks) makes one difficulty period, and each one becomes a ring in the
					strip above. The list shows the newest blocks first, fading back into the deep history
					below.
				</p>
				<p>
					Heartwood reads all of this from a Bitcoin node rather than a third-party website. When it
					runs on <strong>your own node, that node keeps a full copy</strong> of the entire chain, so
					every figure here is checked locally instead of taken on trust. Click anything — blocks
					hold transactions, transactions move coins between addresses, and every hop is a link.
				</p>
				<p>
					The search box understands block heights (like 800000), block hashes, transaction IDs, and
					addresses — paste any of them and Heartwood works out what it is.
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
		width: 480px;
		max-width: 100%;
		height: 48px;
		background: var(--search-fill);
		border: 1px solid var(--hairline);
		border-radius: 24px;
		padding: 0 22px;
		gap: 12px;
		transition: border-color 120ms var(--ease), box-shadow 120ms var(--ease);
	}

	.search:focus-within {
		border-color: var(--accent);
		box-shadow: 0 0 0 3px var(--accent-muted);
	}

	.search-icon {
		display: flex;
		color: var(--accent);
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
		margin-top: 14px;
	}

	/* One quiet stale-snapshot line (spec §2.5) — the honest replacement for a
	   "node unreachable" banner beside a full block list. */
	.stale-note {
		margin-top: 14px;
		font-size: 12.5px;
		color: var(--text-muted);
	}

	.chain-error-text strong {
		color: var(--text);
		margin-right: 6px;
	}

	.chain-error-text .detail {
		color: var(--text-secondary);
	}

	.retry {
		color: inherit;
		text-decoration: underline;
		white-space: nowrap;
		background: none;
		border: none;
		padding: 0;
		font: inherit;
		cursor: pointer;
	}

	.chain-error .check-settings {
		color: var(--text-secondary);
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

	/* Tip counter roll on a genuine new block (cairn-6efi.2) — one-shot, calm. */
	.hero-height.roll {
		animation: tip-roll 0.6s var(--ease) 1;
	}

	@keyframes tip-roll {
		0% {
			transform: translateY(0.28em);
			opacity: 0;
		}
		100% {
			transform: translateY(0);
			opacity: 1;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.hero-height.roll {
			animation: none;
		}
	}

	/* Genuinely disconnected (not loading) — a calm dash, not a shimmering
	   fake number and not hidden text; it should read as "nothing here"
	   at a glance, unlike .skeleton which reads as "still coming". */
	.hero-height.dash {
		color: var(--text-faint);
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

	/* SWR freshness indicator: muted when idle, copper while refreshing. */
	.sync-status {
		color: var(--text-faint);
	}

	.sync-status.updating {
		color: var(--accent);
	}

	/* --- up next strip --- */
	.upcoming {
		margin-top: 28px;
	}

	.upcoming-head {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 12px;
		margin-bottom: 10px;
	}

	.upcoming-title {
		font-size: 13px;
		font-weight: 600;
		letter-spacing: 0.03em;
		color: var(--text-secondary);
	}

	.upcoming-link {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		font-size: 12px;
		font-weight: 500;
		color: var(--accent);
		white-space: nowrap;
	}

	.upcoming-row {
		display: flex;
		gap: 10px;
		overflow-x: auto;
		padding-bottom: 2px;
	}

	.upcoming-chip {
		flex: 0 0 118px;
		display: flex;
		flex-direction: column;
		gap: 2px;
		padding: 10px 12px;
		border-radius: var(--radius-strip);
		background: linear-gradient(
			160deg,
			rgba(103, 150, 201, calc(0.18 - var(--depth) * 0.03)),
			rgba(103, 150, 201, 0.04)
		);
		border: 1px solid rgba(103, 150, 201, calc(0.3 - var(--depth) * 0.05));
	}

	.upcoming-chip.next {
		border-color: var(--accent);
	}

	.chip-eta {
		font-size: 10px;
		font-weight: 600;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--accent);
	}

	.chip-fee {
		font-family: var(--font-serif);
		font-size: 17px;
		font-weight: 600;
		color: var(--text);
	}

	.chip-range {
		font-size: 10.5px;
		color: var(--text-muted);
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
		color: var(--text-secondary);
	}

	/* --- latest rings --- */
	.rings {
		margin-top: 40px;
	}

	/* 2/3 + 1/3 split at the desktop tier; the rail is hidden below it and the
	   list runs full-width (mobile keeps the net-footer summary). */
	.explorer-rail {
		display: none;
	}

	@media (min-width: 1160px) {
		.rings-layout {
			display: grid;
			grid-template-columns: minmax(0, 1fr) var(--rail-w);
			gap: var(--lane-gutter);
			align-items: start;
		}

		.explorer-rail {
			display: flex;
			flex-direction: column;
			gap: 26px;
			margin-top: 40px;
			position: sticky;
			top: 24px;
		}

		.rail-block {
			display: flex;
			flex-direction: column;
			gap: 3px;
			padding-bottom: 22px;
			border-bottom: 1px solid var(--hairline);
		}

		.rail-block:last-child {
			border-bottom: none;
			padding-bottom: 0;
		}

		.rail-eyebrow {
			font-size: 11px;
			font-weight: 600;
			letter-spacing: 0.14em;
			text-transform: uppercase;
			color: var(--eyebrow-path);
		}

		.rail-value {
			font-family: var(--font-serif);
			font-size: 22px;
			font-weight: 600;
			color: var(--text-value);
		}

		/* The FeeRate unit stays small/UI-font inside the big serif rail value. */
		.rail-value :global(.fr-unit) {
			font-family: var(--font-ui);
			font-size: 12px;
			font-weight: 400;
			color: var(--text-muted);
		}

		.rail-sub {
			font-size: 12.5px;
			color: var(--text-muted);
		}

		.rail-sub.updating {
			color: var(--accent);
		}

		.rail-link {
			margin-top: 4px;
			font-size: 12.5px;
			font-weight: 500;
			color: var(--accent);
		}
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

	/* Head column: block height + optional "Yours" pip, fixed width so the
	   fullness sliver and meta stay aligned across rows (T-C, cairn-6efi.4). */
	.row-headcol {
		display: flex;
		align-items: baseline;
		flex-wrap: wrap;
		gap: 7px;
		row-gap: 3px;
		width: 118px;
		flex-shrink: 0;
	}

	.row-height {
		font-family: var(--font-serif);
		font-weight: 600;
		font-size: 16px;
		color: var(--text-value);
		transition: color 120ms var(--ease);
	}

	.row-height.tip {
		color: var(--accent-bright);
	}

	/* "Yours" pip — sage, quiet; the viewer has a tx in this block. */
	.yours-pip {
		font-size: 9.5px;
		font-weight: 600;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		color: var(--sage);
		background: var(--sage-muted);
		padding: 1px 6px;
		border-radius: 999px;
		white-space: nowrap;
	}

	/* "Found here" pip (cairn-r1hca) — same growth-green chip family as
	   "Yours"; this instance's own pool found the block. Beats the generic
	   "Likely {pool}" meta-line label for that row (never both). */
	.found-pip {
		font-size: 9.5px;
		font-weight: 600;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		color: var(--sage);
		background: var(--sage-muted);
		padding: 1px 6px;
		border-radius: 999px;
		white-space: nowrap;
	}

	/* Fullness sliver spacer keeps the pending row's meta aligned with block rows. */
	.ringbar-spacer {
		width: 40px;
		flex-shrink: 0;
	}

	/* Pool + fee-range + BTC-moved detail tokens live in the meta line; each is
	   rendered only when its stat is present (null degrades to nothing). */
	.row-pool {
		color: var(--text-secondary);
	}

	.row-detail {
		color: var(--text-faint);
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
		color: var(--text-value);
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

		.upcoming {
			margin-top: 18px;
		}

		.upcoming-title {
			font-size: 11.5px;
		}

		.upcoming-chip {
			flex: 0 0 96px;
			padding: 8px 10px;
		}

		.chip-fee {
			font-size: 15px;
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

		.row-headcol {
			width: 88px;
			gap: 5px;
		}

		.row-height {
			font-size: 13.5px;
		}

		.yours-pip,
		.found-pip {
			font-size: 8.5px;
			padding: 1px 5px;
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

		/* Fullness sliver + its pending-row spacer fold away on mobile; the size
		   column already hides here, and the meta line carries the rich detail. */
		.ringbar-spacer {
			display: none;
		}

		:global(.ring-row .ringbar) {
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
