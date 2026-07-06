<script lang="ts">
	import Icon from '$lib/components/Icon.svelte';
	import { timeAgo } from '$lib/format';

	type AdminEvent = {
		id: number;
		type: string;
		level: 'info' | 'success' | 'warn' | 'error';
		message: string;
		detail: Record<string, unknown> | null;
		createdAt: string;
		userId: number | null;
		userEmail: string | null;
		userName: string | null;
	};

	let { data } = $props();

	// One-time seeds from the server load (this page owns filtering/paging locally).
	// svelte-ignore state_referenced_locally
	const types = data.types as string[];
	// svelte-ignore state_referenced_locally
	const users = data.users as { id: number; email: string; name: string }[];
	// svelte-ignore state_referenced_locally
	let events = $state<AdminEvent[]>(data.events as AdminEvent[]);
	// svelte-ignore state_referenced_locally
	let total = $state<number>(data.total as number);

	// Filters
	let fType = $state('');
	let fLevel = $state('');
	let fUser = $state(''); // '' = any, 'instance' = instance-wide, or a user id
	let search = $state('');
	let loading = $state(false);
	let loadError = $state<string | null>(null);

	const PAGE = 200;
	let offset = $state(0);

	function query(off: number): string {
		const p = new URLSearchParams();
		if (fType) p.set('type', fType);
		if (fLevel) p.set('level', fLevel);
		if (fUser) p.set('userId', fUser);
		if (search.trim()) p.set('search', search.trim());
		p.set('limit', String(PAGE));
		p.set('offset', String(off));
		return p.toString();
	}

	async function load(off = 0, append = false) {
		loading = true;
		loadError = null;
		try {
			const res = await fetch(`/api/admin/activity?${query(off)}`);
			if (!res.ok) {
				loadError = `Could not load the activity log (${res.status}). Try again.`;
				return;
			}
			const body = (await res.json()) as { events: AdminEvent[]; total: number };
			offset = off;
			total = body.total;
			events = append ? [...events, ...body.events] : body.events;
		} catch {
			loadError = 'Could not reach the server. Check your connection and try again.';
		} finally {
			loading = false;
		}
	}

	function applyFilters() {
		load(0, false);
	}
	function loadMore() {
		load(offset + PAGE, true);
	}
	function resetFilters() {
		fType = '';
		fLevel = '';
		fUser = '';
		search = '';
		load(0, false);
	}

	function fullTime(iso: string): string {
		const d = new Date(iso);
		return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
	}
	function ago(iso: string): string {
		const s = Math.floor(new Date(iso).getTime() / 1000);
		return Number.isFinite(s) ? timeAgo(s) : '';
	}
	function who(e: AdminEvent): string {
		if (e.userId === null) return 'Instance';
		return e.userName || e.userEmail || `User #${e.userId}`;
	}
</script>

<svelte:head><title>Activity log — Admin — Cairn</title></svelte:head>

<div class="head">
	<div>
		<h2 class="section-title">Activity log</h2>
		<p class="hint">
			Every event on this instance — logins, wallet operations, signing sessions, server health,
			and network activity, across all users. The per-user
			<a href="/activity">Activity</a> feed shows each person only their own bitcoin activity.
		</p>
	</div>
</div>

<div class="card card-pad filters">
	<div class="filter-row">
		<div class="field">
			<label class="label" for="f-type">Event type</label>
			<select class="input select" id="f-type" bind:value={fType}>
				<option value="">All types</option>
				{#each types as t (t)}<option value={t}>{t}</option>{/each}
			</select>
		</div>
		<div class="field">
			<label class="label" for="f-level">Level</label>
			<select class="input select" id="f-level" bind:value={fLevel}>
				<option value="">All levels</option>
				<option value="info">info</option>
				<option value="success">success</option>
				<option value="warn">warn</option>
				<option value="error">error</option>
			</select>
		</div>
		<div class="field">
			<label class="label" for="f-user">User</label>
			<select class="input select" id="f-user" bind:value={fUser}>
				<option value="">All users</option>
				<option value="instance">Instance-wide</option>
				{#each users as u (u.id)}<option value={String(u.id)}>{u.name} ({u.email})</option>{/each}
			</select>
		</div>
		<div class="field grow">
			<label class="label" for="f-search">Search message</label>
			<input
				class="input"
				id="f-search"
				placeholder="e.g. broadcast, wallet name…"
				bind:value={search}
				onkeydown={(e) => e.key === 'Enter' && applyFilters()}
			/>
		</div>
	</div>
	<div class="filter-actions">
		<button class="btn btn-primary btn-sm" onclick={applyFilters} disabled={loading}>
			{#if loading}<span class="spinner"></span>{:else}<Icon name="search" size={14} />{/if}
			Apply
		</button>
		<button class="btn btn-ghost btn-sm" onclick={resetFilters} disabled={loading}>Reset</button>
		<span class="count">{events.length} of {total}</span>
	</div>
	{#if loadError}
		<div class="form-error" role="alert" style="margin-top: 10px">{loadError}</div>
	{/if}
</div>

<div class="card">
	{#if events.length === 0}
		<div class="empty">No events match these filters.</div>
	{:else}
		<div class="table-scroll">
			<table class="log">
				<thead>
					<tr><th>Time</th><th>User</th><th>Type</th><th>Level</th><th>Message</th></tr>
				</thead>
				<tbody>
					{#each events as e (e.id)}
						<tr class="lvl-{e.level}">
							<td class="nowrap" title={fullTime(e.createdAt)}>{ago(e.createdAt)}</td>
							<td class="nowrap who" class:instance={e.userId === null}>{who(e)}</td>
							<td class="nowrap"><code>{e.type}</code></td>
							<td class="nowrap"><span class="badge lvl">{e.level}</span></td>
							<td class="msg">{e.message}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
		{#if events.length < total}
			<div class="more">
				<button class="btn btn-secondary btn-sm" onclick={loadMore} disabled={loading}>
					{#if loading}<span class="spinner"></span>{/if} Load more
				</button>
			</div>
		{/if}
	{/if}
</div>

<style>
	.head {
		margin-bottom: 14px;
	}
	.hint a {
		color: var(--accent);
	}
	.filters {
		margin-bottom: 14px;
	}
	.filter-row {
		display: flex;
		flex-wrap: wrap;
		gap: 12px;
	}
	.field {
		display: flex;
		flex-direction: column;
		gap: 4px;
		min-width: 150px;
	}
	.field.grow {
		flex: 1;
		min-width: 220px;
	}
	.filter-actions {
		display: flex;
		align-items: center;
		gap: 10px;
		margin-top: 12px;
	}
	.count {
		margin-left: auto;
		color: var(--text-muted);
		font-size: 0.85rem;
	}
	.table-scroll {
		overflow-x: auto;
	}
	table.log {
		width: 100%;
		border-collapse: collapse;
		font-size: 0.85rem;
	}
	.log th,
	.log td {
		text-align: left;
		padding: 8px 10px;
		border-bottom: 1px solid var(--border-subtle);
		vertical-align: top;
	}
	.log th {
		color: var(--text-muted);
		font-weight: 600;
		position: sticky;
		top: 0;
		background: var(--bg-elevated, var(--bg));
	}
	.nowrap {
		white-space: nowrap;
	}
	.who.instance {
		color: var(--text-muted);
		font-style: italic;
	}
	.log code {
		font-size: 0.8rem;
		color: var(--text-muted);
	}
	.msg {
		width: 100%;
	}
	.badge.lvl {
		font-size: 0.72rem;
		text-transform: uppercase;
		letter-spacing: 0.03em;
	}
	.lvl-warn td {
		background: color-mix(in srgb, var(--warning) 8%, transparent);
	}
	.lvl-error td {
		background: color-mix(in srgb, var(--error) 10%, transparent);
	}
	.empty,
	.more {
		padding: 22px;
		text-align: center;
		color: var(--text-muted);
	}
</style>
