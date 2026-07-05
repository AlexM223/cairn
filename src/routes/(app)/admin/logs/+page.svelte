<script lang="ts">
	import Icon from '$lib/components/Icon.svelte';

	type LogEntry = {
		time: number | null;
		level: number;
		levelName: string;
		tag?: string;
		msg: string;
		fields?: Record<string, unknown>;
		raw: string;
	};
	type LoadData = { entries: LogEntry[]; file: string; available: boolean };

	let { data }: { data: LoadData } = $props();

	let fetched = $state<LogEntry[] | null>(null);
	const entries = $derived(fetched ?? data.entries);

	let level = $state<'all' | 'debug' | 'info' | 'warn' | 'error'>('all');
	let query = $state('');
	let auto = $state(false);
	let refreshing = $state(false);
	// Keyed by each entry's position in `entries`: log lines can be byte-for-byte
	// identical (e.g. a duplicate "new block" emit on an electrum reconnect), so
	// the line text is NOT a unique key — position is.
	let expanded = $state<Set<number>>(new Set());

	const LEVEL_MIN: Record<string, number> = { all: 0, debug: 20, info: 30, warn: 40, error: 50 };

	const shown = $derived.by(() => {
		const min = LEVEL_MIN[level];
		const q = query.trim().toLowerCase();
		// Carry each entry's index in the full list so the keyed {#each} has a
		// stable unique key even when two lines are textually identical — keying
		// by the line itself throws Svelte's each_key_duplicate and crashes the
		// whole app shell. Filtering never reorders `entries`, so the id is stable.
		const out: { e: LogEntry; id: number }[] = [];
		entries.forEach((e, id) => {
			if (e.level >= min && (q === '' || e.raw.toLowerCase().includes(q))) {
				out.push({ e, id });
			}
		});
		return out;
	});

	async function refresh() {
		if (refreshing) return;
		refreshing = true;
		try {
			// Always pull the last 1000 lines; filtering happens client-side so it
			// stays instant and the level/search can change without a round-trip.
			const res = await fetch('/api/admin/logs?limit=1000');
			if (res.ok) {
				const body = (await res.json()) as LoadData;
				fetched = body.entries;
			}
		} catch {
			// Keep the current view on a transient failure.
		} finally {
			refreshing = false;
		}
	}

	$effect(() => {
		if (!auto) return;
		const t = setInterval(refresh, 5_000);
		return () => clearInterval(t);
	});

	function toggle(id: number) {
		const next = new Set(expanded);
		if (next.has(id)) next.delete(id);
		else next.add(id);
		expanded = next;
	}

	function ts(time: number | null): string {
		if (time == null) return '—';
		const d = new Date(time);
		if (Number.isNaN(d.getTime())) return '—';
		const hh = String(d.getHours()).padStart(2, '0');
		const mm = String(d.getMinutes()).padStart(2, '0');
		const ss = String(d.getSeconds()).padStart(2, '0');
		const ms = String(d.getMilliseconds()).padStart(3, '0');
		return `${hh}:${mm}:${ss}.${ms}`;
	}
	function fullTs(time: number | null): string {
		return time == null ? '' : new Date(time).toLocaleString();
	}
</script>

<svelte:head>
	<title>Server logs — Cairn</title>
</svelte:head>

<div class="bar">
	<div class="filters">
		<select class="select lvl" bind:value={level} aria-label="Minimum level">
			<option value="all">All levels</option>
			<option value="debug">Debug &amp; up</option>
			<option value="info">Info &amp; up</option>
			<option value="warn">Warn &amp; up</option>
			<option value="error">Errors</option>
		</select>
		<input class="input search" type="search" placeholder="Search logs…" bind:value={query} />
	</div>
	<div class="actions">
		<label class="auto" title="Refresh every 5 seconds">
			<input type="checkbox" bind:checked={auto} />
			Auto-refresh
		</label>
		<button class="btn btn-secondary btn-sm" onclick={refresh} disabled={refreshing}>
			{#if refreshing}<span class="spinner"></span>{:else}<Icon name="refresh" size={14} />{/if}
			Refresh
		</button>
	</div>
</div>

<div class="meta-row">
	<span class="hint">
		Showing {shown.length} of {entries.length} recent lines · <span class="mono">{data.file}</span>
	</span>
</div>

<div class="card console">
	{#if !data.available}
		<div class="empty-state">
			<Icon name="server" size={22} />
			<span class="empty-title">No log file yet</span>
			<span
				>Nothing has been written to <span class="mono">{data.file}</span> yet, or file logging is
				disabled (CAIRN_LOG_TO_FILE=false). Logs still stream to stdout.</span
			>
		</div>
	{:else if shown.length === 0}
		<div class="empty-state">
			<span class="empty-title">No matching lines</span>
			<span>Try a lower level or a different search.</span>
		</div>
	{:else}
		<ul class="log">
			{#each shown as { e, id } (id)}
				{@const open = expanded.has(id)}
				<li class="line lvl-{e.levelName}">
					<button
						class="row"
						class:has-fields={!!e.fields}
						onclick={() => e.fields && toggle(id)}
						type="button"
					>
						<time class="t" title={fullTs(e.time)}>{ts(e.time)}</time>
						<span class="lv">{e.levelName}</span>
						{#if e.tag}<span class="tag">{e.tag}</span>{/if}
						<span class="msg">{e.msg}</span>
						{#if e.fields}
							<Icon name={open ? 'chevron-down' : 'chevron-right'} size={13} />
						{/if}
					</button>
					{#if open && e.fields}
						<pre class="fields">{JSON.stringify(e.fields, null, 2)}</pre>
					{/if}
				</li>
			{/each}
		</ul>
	{/if}
</div>

<style>
	.bar {
		display: flex;
		align-items: center;
		gap: 12px;
		flex-wrap: wrap;
		margin-bottom: 10px;
	}
	.filters {
		display: flex;
		gap: 8px;
		flex: 1;
		min-width: 220px;
	}
	.lvl {
		width: auto;
		flex-shrink: 0;
	}
	.search {
		flex: 1;
		min-width: 140px;
	}
	.actions {
		display: flex;
		align-items: center;
		gap: 10px;
	}
	.auto {
		display: flex;
		align-items: center;
		gap: 6px;
		font-size: 12.5px;
		color: var(--text-secondary);
		white-space: nowrap;
		cursor: pointer;
	}
	.auto input {
		accent-color: var(--accent);
	}
	.meta-row {
		margin-bottom: 10px;
	}
	.meta-row .mono {
		color: var(--text-secondary);
	}

	.console {
		padding: 6px 0;
		overflow: hidden;
	}
	.log {
		list-style: none;
		margin: 0;
		padding: 0;
		font-family: var(--font-mono);
		font-size: 12.5px;
	}
	.line {
		border-bottom: 1px solid var(--border-subtle);
	}
	.line:last-child {
		border-bottom: none;
	}
	.row {
		display: flex;
		align-items: baseline;
		gap: 10px;
		width: 100%;
		text-align: left;
		background: transparent;
		border: none;
		color: var(--text-secondary);
		padding: 6px 16px;
		cursor: default;
		font: inherit;
	}
	.row.has-fields {
		cursor: pointer;
	}
	.row.has-fields:hover {
		background: rgba(255, 255, 255, 0.02);
	}
	.t {
		color: var(--text-faint);
		flex-shrink: 0;
		font-variant-numeric: tabular-nums;
	}
	.lv {
		flex-shrink: 0;
		width: 42px;
		text-transform: uppercase;
		font-size: 10.5px;
		font-weight: 600;
		letter-spacing: 0.03em;
		color: var(--text-muted);
	}
	.tag {
		flex-shrink: 0;
		color: var(--accent);
		opacity: 0.85;
	}
	.msg {
		flex: 1;
		min-width: 0;
		color: var(--text);
		white-space: pre-wrap;
		word-break: break-word;
	}
	.lvl-warn .lv {
		color: var(--warning);
	}
	.lvl-error .lv,
	.lvl-fatal .lv {
		color: var(--error);
	}
	.lvl-warn .msg {
		color: var(--warning);
	}
	.lvl-error .msg,
	.lvl-fatal .msg {
		color: #f0a0a0;
	}
	.lvl-debug .msg,
	.lvl-trace .msg {
		color: var(--text-muted);
	}

	.fields {
		margin: 0;
		padding: 8px 16px 12px 62px;
		font-family: var(--font-mono);
		font-size: 11.5px;
		color: var(--text-secondary);
		background: var(--bg);
		white-space: pre-wrap;
		word-break: break-word;
		overflow-x: auto;
	}
</style>
