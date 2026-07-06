<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import Icon from '$lib/components/Icon.svelte';
	import { timeAgo } from '$lib/format';
	import type { ContactList, ContactSummary } from '$lib/server/contacts';

	let { data } = $props();
	const contacts = $derived(data.contacts as ContactList);

	let email = $state('');
	let busy = $state(false);
	let error = $state<string | null>(null);
	let notice = $state<string | null>(null);

	async function add(e: SubmitEvent) {
		e.preventDefault();
		error = null;
		notice = null;
		const value = email.trim();
		if (!value) return;
		busy = true;
		try {
			const res = await fetch('/api/contacts', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ email: value })
			});
			const body = await res.json().catch(() => null);
			if (!res.ok) throw new Error(body?.error || 'Could not send that request.');
			// Deliberately identical whether or not the account exists — see the
			// anti-enumeration note in contacts.ts.
			notice = `If ${value} has an account here, they'll see your request.`;
			email = '';
			await invalidateAll();
		} catch (err) {
			error = err instanceof Error ? err.message : 'Could not send that request.';
		} finally {
			busy = false;
		}
	}

	async function respond(id: number, accept: boolean) {
		busy = true;
		error = null;
		try {
			const res = await fetch(`/api/contacts/${id}`, {
				method: 'PATCH',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ accept })
			});
			if (!res.ok) throw new Error((await res.json().catch(() => null))?.error || 'Action failed.');
			await invalidateAll();
		} catch (err) {
			error = err instanceof Error ? err.message : 'Action failed.';
		} finally {
			busy = false;
		}
	}

	async function remove(c: ContactSummary, verb: string) {
		if (!confirm(`${verb} ${c.displayName}?`)) return;
		busy = true;
		error = null;
		try {
			const res = await fetch(`/api/contacts/${c.id}`, { method: 'DELETE' });
			if (!res.ok) throw new Error((await res.json().catch(() => null))?.error || 'Action failed.');
			await invalidateAll();
		} catch (err) {
			error = err instanceof Error ? err.message : 'Action failed.';
		} finally {
			busy = false;
		}
	}
</script>

<svelte:head><title>Contacts · Settings · Cairn</title></svelte:head>

<div class="wrap">
	<a class="back" href="/settings"><Icon name="chevron-left" size={16} /> Settings</a>
	<h1>Contacts</h1>
	<p class="lead">
		Contacts are the people you can share a wallet with. Adding someone shows them
		your name and email — this is how you recognise each other, so only add people
		you know.
	</p>

	{#if error}<div class="form-error" role="alert">{error}</div>{/if}

	<section class="card card-pad section">
		<span class="card-title">Add a contact</span>
		<form onsubmit={add}>
			<div class="field">
				<label class="label" for="contact-email">Their email address</label>
				<div class="row">
					<input
						class="input"
						id="contact-email"
						type="email"
						placeholder="friend@example.com"
						bind:value={email}
						disabled={busy}
					/>
					<button class="btn btn-primary" disabled={busy || !email.trim()}>Send request</button>
				</div>
			</div>
			{#if notice}<p class="notice">{notice}</p>{/if}
		</form>
	</section>

	{#if contacts.requestsReceived.length}
		<section class="card card-pad section">
			<span class="card-title">Requests for you</span>
			<ul class="people">
				{#each contacts.requestsReceived as c (c.id)}
					<li>
						<div class="who">
							<span class="name">{c.displayName}</span>
							<span class="email">{c.email}</span>
						</div>
						<div class="actions">
							<button class="btn btn-primary btn-sm" disabled={busy} onclick={() => respond(c.id, true)}>
								Accept
							</button>
							<button class="btn btn-ghost btn-sm" disabled={busy} onclick={() => respond(c.id, false)}>
								Decline
							</button>
						</div>
					</li>
				{/each}
			</ul>
		</section>
	{/if}

	<section class="card card-pad section">
		<span class="card-title">Your contacts</span>
		{#if contacts.friends.length}
			<ul class="people">
				{#each contacts.friends as c (c.id)}
					<li>
						<div class="who">
							<span class="name">{c.displayName}</span>
							<span class="email">{c.email}</span>
						</div>
						<button class="btn btn-ghost btn-sm danger" disabled={busy} onclick={() => remove(c, 'Remove')}>
							Remove
						</button>
					</li>
				{/each}
			</ul>
		{:else}
			<p class="empty">
				No contacts yet. Add someone by their email above to start sharing a
				multisig wallet with them.
			</p>
		{/if}
	</section>

	{#if contacts.requestsSent.length}
		<section class="card card-pad section">
			<span class="card-title">Pending requests you sent</span>
			<ul class="people">
				{#each contacts.requestsSent as c (c.id)}
					<li>
						<div class="who">
							<span class="name">{c.displayName}</span>
							<span class="email">{c.email}</span>
							<span class="muted">Sent {timeAgo(Math.floor(Date.parse(c.createdAt) / 1000))}</span>
						</div>
						<button class="btn btn-ghost btn-sm" disabled={busy} onclick={() => remove(c, 'Cancel the request to')}>
							Cancel
						</button>
					</li>
				{/each}
			</ul>
		</section>
	{/if}
</div>

<style>
	.wrap {
		max-width: 640px;
		margin: 0 auto;
	}
	.back {
		display: inline-flex;
		align-items: center;
		gap: 0.35rem;
		color: var(--text-muted);
		font-size: 0.9rem;
		text-decoration: none;
		margin-bottom: 0.75rem;
	}
	.back:hover {
		color: var(--text);
	}
	h1 {
		margin: 0 0 0.4rem;
	}
	.lead {
		color: var(--text-muted);
		margin: 0 0 1.25rem;
		line-height: 1.5;
	}
	.section {
		margin-bottom: 1rem;
	}
	.row {
		display: flex;
		gap: 0.5rem;
	}
	.row .input {
		flex: 1;
	}
	.notice {
		margin: 0.6rem 0 0;
		color: var(--text-muted);
		font-size: 0.9rem;
	}
	.people {
		list-style: none;
		margin: 0.25rem 0 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}
	.people li {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.75rem;
		padding: 0.6rem 0;
		border-top: 1px solid var(--border);
	}
	.people li:first-child {
		border-top: none;
	}
	.who {
		display: flex;
		flex-direction: column;
		gap: 0.1rem;
		min-width: 0;
	}
	.name {
		font-weight: 600;
	}
	.email,
	.muted {
		color: var(--text-muted);
		font-size: 0.85rem;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.actions {
		display: flex;
		gap: 0.4rem;
		flex-shrink: 0;
	}
	.empty {
		color: var(--text-muted);
		margin: 0.25rem 0 0;
	}
</style>
