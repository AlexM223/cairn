<script lang="ts">
	import { enhance } from '$app/forms';
	import Icon from '$lib/components/Icon.svelte';
	import AnnouncementBanner from '$lib/components/AnnouncementBanner.svelte';
	import Banner from '$lib/components/Banner.svelte';

	let { data, form } = $props();

	// Friendly labels for the four types (server validates the values).
	const TYPES = [
		{ value: 'info', label: 'Info' },
		{ value: 'warning', label: 'Warning' },
		{ value: 'urgent', label: 'Urgent' },
		{ value: 'promotion', label: 'Promotion' }
	];

	const typeBadge: Record<string, string> = {
		info: 'badge-neutral',
		warning: 'badge-warning',
		urgent: 'badge-error',
		promotion: 'badge-accent'
	};

	// One editor for both create and edit: "Edit" on a row fills it and flips
	// the action to ?/update. The live preview below always mirrors the editor.
	let editingId = $state<number | null>(null);
	let type = $state('info');
	let title = $state('');
	let body = $state('');
	let linkUrl = $state('');
	let linkText = $state('');
	let dismissible = $state(true);
	let active = $state(true);
	let expiresAt = $state(''); // datetime-local value (local time; server converts)
	let displayOrder = $state(0);
	let saving = $state(false);

	function resetEditor() {
		editingId = null;
		type = 'info';
		title = '';
		body = '';
		linkUrl = '';
		linkText = '';
		dismissible = true;
		active = true;
		expiresAt = '';
		displayOrder = 0;
	}

	/** ISO UTC → the zone-less local format datetime-local inputs want. */
	function toLocalInput(iso: string | null): string {
		if (!iso) return '';
		const d = new Date(iso);
		if (Number.isNaN(d.getTime())) return '';
		const pad = (n: number) => String(n).padStart(2, '0');
		return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
	}

	function startEdit(a: (typeof data.announcements)[number]) {
		editingId = a.id;
		type = a.type;
		title = a.title;
		body = a.body;
		linkUrl = a.linkUrl ?? '';
		linkText = a.linkText ?? '';
		dismissible = a.dismissible;
		active = a.active;
		expiresAt = toLocalInput(a.expiresAt);
		displayOrder = a.displayOrder;
	}

	function isExpired(a: { expiresAt: string | null }): boolean {
		return !!a.expiresAt && Date.parse(a.expiresAt) <= Date.now();
	}

	function expiryLabel(iso: string | null): string {
		if (!iso) return 'never';
		const d = new Date(iso);
		if (Number.isNaN(d.getTime())) return iso;
		return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
	}
</script>

<svelte:head>
	<title>Announcements — Health — Heartwood</title>
</svelte:head>

{#if !data.enabled}
	<!-- Flag-off state: the registry says "Off = ... the admin announcements
	     page is disabled", so no editor — just where to turn it back on. -->
	<div class="disabled-note fade-in">
		<Icon name="info" size={18} />
		<div>
			<div class="disabled-title">Announcement banners are turned off</div>
			<p class="hint">
				No banners are shown to anyone while this feature is off. Turn on “Announcement banners”
				under <a href="/admin/feature-flags">Feature flags</a> to write and manage announcements.
			</p>
		</div>
	</div>
{:else}
	<p class="lead">
		Announcements appear as a banner for every user until they expire, are turned off, or (when
		allowed) each person dismisses them. Plain text only — the optional link is how you point
		somewhere.
	</p>

	{#if form?.error}
		<div style="margin-bottom: 14px"><Banner variant="error">{form.error}</Banner></div>
	{/if}

	<section class="hw-section editor-section fade-in">
		<span class="hw-title">{editingId === null ? 'New announcement' : 'Edit announcement'}</span>
		<form
			method="POST"
			action={editingId === null ? '?/create' : '?/update'}
			class="editor-form"
			use:enhance={({ cancel }) => {
				if (saving) return cancel();
				saving = true;
				return async ({ result, update }) => {
					saving = false;
					if (result.type === 'success') resetEditor();
					await update();
				};
			}}
		>
			{#if editingId !== null}
				<input type="hidden" name="id" value={editingId} />
			{/if}

			<div class="row">
				<div class="field narrow">
					<label class="label" for="a-type">Type</label>
					<select class="select" id="a-type" name="type" bind:value={type}>
						{#each TYPES as t (t.value)}
							<option value={t.value}>{t.label}</option>
						{/each}
					</select>
				</div>
				<div class="field">
					<label class="label" for="a-title">Title</label>
					<input
						class="input"
						id="a-title"
						name="title"
						maxlength="120"
						placeholder="e.g. Maintenance this Sunday"
						bind:value={title}
					/>
				</div>
			</div>

			<div class="field">
				<label class="label" for="a-body">Message</label>
				<textarea
					class="input"
					id="a-body"
					name="body"
					rows="2"
					maxlength="500"
					placeholder="Plain text — keep it to a sentence or two."
					bind:value={body}
				></textarea>
			</div>

			<div class="row">
				<div class="field">
					<label class="label" for="a-link">Link <span class="opt">optional</span></label>
					<input
						class="input"
						id="a-link"
						name="linkUrl"
						placeholder="https://… or /settings"
						bind:value={linkUrl}
					/>
				</div>
				<div class="field">
					<label class="label" for="a-link-text">Link text <span class="opt">optional</span></label>
					<input
						class="input"
						id="a-link-text"
						name="linkText"
						maxlength="60"
						placeholder="Learn more"
						bind:value={linkText}
					/>
				</div>
			</div>

			<div class="row">
				<div class="field">
					<label class="label" for="a-expires">Expires <span class="opt">optional</span></label>
					<input
						class="input"
						id="a-expires"
						name="expiresAt"
						type="datetime-local"
						bind:value={expiresAt}
					/>
				</div>
				<div class="field narrow">
					<label class="label" for="a-order">Display order <span class="opt">low first</span></label>
					<input
						class="input"
						id="a-order"
						name="displayOrder"
						type="number"
						step="1"
						bind:value={displayOrder}
					/>
				</div>
				<label class="check">
					<input type="checkbox" name="dismissible" bind:checked={dismissible} />
					Users can dismiss it
				</label>
				<label class="check">
					<input type="checkbox" name="active" bind:checked={active} />
					Active
				</label>
			</div>

			<div class="editor-actions">
				<button type="submit" class="btn btn-primary" disabled={saving}>
					{#if saving}<span class="spinner"></span>{:else}<Icon
							name={editingId === null ? 'plus' : 'check'}
							size={15}
						/>{/if}
					{editingId === null ? 'Publish' : 'Save changes'}
				</button>
				{#if editingId !== null}
					<button type="button" class="btn btn-ghost" onclick={resetEditor}>Cancel</button>
				{/if}
			</div>
		</form>

		<div class="preview">
			<span class="label">Preview — exactly how users will see it</span>
			<div class="preview-frame">
				<AnnouncementBanner
					preview
					announcement={{
						type,
						title: title.trim() || 'Your title',
						body: body.trim() || 'Your message shows here.',
						linkUrl: linkUrl.trim() || null,
						linkText: linkText.trim() || null,
						dismissible
					}}
				/>
			</div>
		</div>
	</section>

	<section class="hw-section fade-in">
		{#if data.announcements.length === 0}
			<div class="empty-state">
				<div class="empty-title">No announcements yet</div>
				<p>Write one above — it appears for every user the moment it's published.</p>
			</div>
		{:else}
			<div class="table-wrap">
				<table class="table">
					<thead>
						<tr>
							<th>Announcement</th>
							<th>Type</th>
							<th>Status</th>
							<th class="num">Order</th>
							<th>Expires</th>
							<th></th>
						</tr>
					</thead>
					<tbody>
						{#each data.announcements as a (a.id)}
							<tr class:editing={editingId === a.id}>
								<td class="title-cell">
									<span class="a-title">{a.title}</span>
									<span class="a-body truncate">{a.body}</span>
								</td>
								<td><span class="badge {typeBadge[a.type] ?? 'badge-neutral'}">{a.type}</span></td>
								<td class="status-cell">
									{#if isExpired(a)}
										<span class="badge badge-warning">expired</span>
									{:else if a.active}
										<span class="badge badge-success">active</span>
									{:else}
										<span class="badge badge-neutral">inactive</span>
									{/if}
									{#if !a.dismissible}
										<span class="badge badge-neutral" title="Users can't dismiss this banner">
											can't dismiss
										</span>
									{/if}
								</td>
								<td class="num">{a.displayOrder}</td>
								<td class="text-muted">{expiryLabel(a.expiresAt)}</td>
								<td class="actions-cell">
									<button class="btn btn-ghost btn-sm" type="button" onclick={() => startEdit(a)}>
										Edit
									</button>
									<form method="POST" action="?/toggleActive" use:enhance style="display: inline">
										<input type="hidden" name="id" value={a.id} />
										<input type="hidden" name="active" value={(!a.active).toString()} />
										<button class="btn btn-ghost btn-sm">
											{a.active ? 'Turn off' : 'Turn on'}
										</button>
									</form>
									<form
										method="POST"
										action="?/delete"
										style="display: inline"
										use:enhance={({ cancel }) => {
											if (!confirm(`Delete “${a.title}”? Users will stop seeing it immediately.`)) {
												cancel();
											}
											return async ({ update }) => {
												if (editingId === a.id) resetEditor();
												await update();
											};
										}}
									>
										<input type="hidden" name="id" value={a.id} />
										<button class="btn btn-ghost btn-sm danger">Delete</button>
									</form>
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/if}
	</section>
{/if}

<style>
	.lead {
		font-size: 13.5px;
		color: var(--text-secondary);
		line-height: 1.5;
		margin-bottom: 20px;
		max-width: 640px;
	}

	.disabled-note {
		display: flex;
		gap: 12px;
		align-items: flex-start;
		max-width: 640px;
		padding: 18px 0;
		border-bottom: 1px solid var(--hairline);
	}

	.disabled-note :global(svg) {
		color: var(--text-muted);
		flex-shrink: 0;
		margin-top: 2px;
	}

	.disabled-title {
		font-size: 13.5px;
		font-weight: 600;
		margin-bottom: 4px;
	}

	.disabled-note a {
		color: var(--accent);
	}

	.editor-section {
		gap: 14px;
	}

	.editor-form {
		display: flex;
		flex-direction: column;
		gap: 12px;
	}

	.row {
		display: flex;
		gap: 12px;
		align-items: flex-end;
		flex-wrap: wrap;
	}

	.row .field {
		flex: 1;
		min-width: 160px;
	}

	.row .narrow {
		flex: 0 0 150px;
	}

	.opt {
		font-weight: 400;
		color: var(--text-muted);
	}

	.check {
		display: flex;
		align-items: center;
		gap: 7px;
		font-size: 13px;
		color: var(--text-secondary);
		padding-bottom: 9px; /* baseline-align with the inputs beside it */
		cursor: pointer;
		white-space: nowrap;
	}

	.check input {
		accent-color: var(--accent);
	}

	.editor-actions {
		display: flex;
		gap: 8px;
	}

	.preview {
		display: flex;
		flex-direction: column;
		gap: 8px;
		border-top: 1px solid var(--hairline);
		padding-top: 14px;
	}

	/* The preview banner keeps its real margin; swallow it so the card ends
	   cleanly. */
	.preview-frame :global(.announcement) {
		margin-bottom: 0;
	}

	.title-cell {
		max-width: 340px;
	}

	.a-title {
		display: block;
		font-weight: 500;
	}

	.a-body {
		display: block;
		font-size: 12px;
		color: var(--text-muted);
		max-width: 320px;
	}

	.status-cell {
		white-space: nowrap;
	}

	.actions-cell {
		text-align: right;
		white-space: nowrap;
	}

	/* Destructive row action stays quiet until intent (no red at rest). */
	.btn.danger {
		color: var(--text-muted);
	}

	.btn.danger:hover:not(:disabled) {
		color: var(--error);
	}

	@media (max-width: 560px) {
		.row {
			flex-direction: column;
			align-items: stretch;
		}

		.row .field,
		.row .narrow {
			flex: none;
			width: 100%;
		}

		.check {
			padding-bottom: 0;
		}
	}
</style>
