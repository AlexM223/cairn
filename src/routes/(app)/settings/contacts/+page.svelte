<script lang="ts">
	import { goto, invalidateAll } from '$app/navigation';
	import { timeAgo } from '$lib/format';
	import type { ContactList, ContactSummary } from '$lib/server/contacts';
	import Banner from '$lib/components/Banner.svelte';
	import GroveField from '$lib/components/heartwood/GroveField.svelte';
	import BackCircle from '$lib/components/heartwood/BackCircle.svelte';
	import EyebrowBreadcrumb from '$lib/components/heartwood/EyebrowBreadcrumb.svelte';
	import Modal from '$lib/components/heartwood/Modal.svelte';

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

	// Removal/cancellation goes through the shared Modal instead of
	// window.confirm — same network logic as before once confirmed.
	let removeTarget = $state<{ contact: ContactSummary; title: string; message: string; label: string } | null>(null);
	let removeOpen = $state(false);

	function askRemove(c: ContactSummary) {
		removeTarget = {
			contact: c,
			title: `Remove ${c.displayName}?`,
			message: `You won't be able to share new wallets with ${c.displayName} until you add each other again. Wallets you already share stay as they are.`,
			label: 'Remove contact'
		};
		removeOpen = true;
	}

	function askCancelRequest(c: ContactSummary) {
		removeTarget = {
			contact: c,
			title: `Cancel the request to ${c.displayName}?`,
			message: `They won't see your contact request. You can always send a new one later.`,
			label: 'Cancel request'
		};
		removeOpen = true;
	}

	async function onRemoveConfirmed() {
		if (!removeTarget) return;
		const { contact } = removeTarget;
		busy = true;
		error = null;
		try {
			const res = await fetch(`/api/contacts/${contact.id}`, { method: 'DELETE' });
			if (!res.ok) throw new Error((await res.json().catch(() => null))?.error || 'Action failed.');
			await invalidateAll();
		} catch (err) {
			error = err instanceof Error ? err.message : 'Action failed.';
		} finally {
			busy = false;
			removeTarget = null;
		}
	}
</script>

<svelte:head>
	<title>Contacts — Settings — Heartwood</title>
</svelte:head>

<div class="grove-bleed" aria-hidden="true"><GroveField volume="whisper" /></div>

<div class="hw-page hw-owns-header fade-in">
	<!-- Mobile flow header: back circle + centered eyebrow + spacer. -->
	<header class="flow-header">
		<BackCircle href="/settings" label="Back to settings" />
		<span class="flow-eyebrow">CONTACTS</span>
		<span class="flow-spacer"></span>
	</header>

	<!-- Desktop eyebrow breadcrumb, linking back to Settings. Navigates via
	     goto(..., { replaceState: true }) rather than a plain <a> so it
	     replaces the current history entry instead of pushing a new one —
	     otherwise Back alternates between here and /settings (cairn-ojvs). -->
	<a
		class="crumb-link"
		href="/settings"
		onclick={(e) => {
			e.preventDefault();
			goto('/settings', { replaceState: true });
		}}
	>
		<EyebrowBreadcrumb path={['Settings']} current="Contacts" />
	</a>

	<h1 class="page-title">Contacts</h1>
	<p class="lede">
		Contacts are the people you can share a wallet with. Adding someone shows them your name and
		email — this is how you recognise each other, so only add people you know.
	</p>

	{#if error}<Banner variant="error">{error}</Banner>{/if}

	<section class="hw-section">
		<h2 class="section-title">Add a contact</h2>
		<form onsubmit={add} class="add-form">
			<div class="field grow">
				<label class="label" for="contact-email">Their email address</label>
				<input
					class="input"
					id="contact-email"
					type="email"
					placeholder="friend@example.com"
					bind:value={email}
					disabled={busy}
				/>
			</div>
			<button class="btn btn-primary" disabled={busy || !email.trim()}>Send request</button>
		</form>
		{#if notice}<p class="notice">{notice}</p>{/if}
	</section>

	{#if contacts.requestsReceived.length}
		<section class="hw-section">
			<h2 class="section-title">Requests for you</h2>
			<ul class="hw-rows">
				{#each contacts.requestsReceived as c (c.id)}
					<li class="hw-row">
						<div class="row-body">
							<div class="row-title">{c.displayName}</div>
							<div class="row-sub">{c.email}</div>
						</div>
						<div class="row-actions">
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

	<section class="hw-section">
		<h2 class="section-title">Your contacts</h2>
		{#if contacts.friends.length}
			<ul class="hw-rows">
				{#each contacts.friends as c (c.id)}
					<li class="hw-row">
						<div class="row-body">
							<div class="row-title">{c.displayName}</div>
							<div class="row-sub">{c.email}</div>
						</div>
						<button class="btn btn-ghost btn-sm" disabled={busy} onclick={() => askRemove(c)}>
							Remove
						</button>
					</li>
				{/each}
			</ul>
		{:else}
			<p class="hint">
				No contacts yet. Add someone by their email above to start sharing a multisig wallet with
				them.
			</p>
		{/if}
	</section>

	{#if contacts.requestsSent.length}
		<section class="hw-section">
			<h2 class="section-title">Pending requests you sent</h2>
			<ul class="hw-rows">
				{#each contacts.requestsSent as c (c.id)}
					<li class="hw-row">
						<div class="row-body">
							<div class="row-title">{c.displayName}</div>
							<div class="row-sub">
								{c.email} · sent {timeAgo(Math.floor(Date.parse(c.createdAt) / 1000))}
							</div>
						</div>
						<button class="btn btn-ghost btn-sm" disabled={busy} onclick={() => askCancelRequest(c)}>
							Cancel
						</button>
					</li>
				{/each}
			</ul>
		</section>
	{/if}
</div>

<Modal
	bind:open={removeOpen}
	title={removeTarget?.title ?? ''}
	message={removeTarget?.message ?? ''}
	confirmLabel={removeTarget?.label ?? 'Confirm'}
	onConfirm={onRemoveConfirmed}
	onCancel={() => (removeTarget = null)}
/>

<style>
	/* Grove field bleeds to the viewport behind the content column. */
	.grove-bleed {
		position: fixed;
		inset: 0;
		z-index: 0;
		pointer-events: none;
	}

	.hw-page {
		position: relative;
		z-index: 1;
		max-width: 660px;
		margin: 0 auto;
	}

	/* This page composes its own mobile flow header, so the shell's
	   bare-back-circle fallback is suppressed while it's mounted. */
	:global(body:has(.hw-owns-header) .mobile-flow-header) {
		display: none;
	}

	.flow-header {
		display: none;
	}

	.flow-eyebrow {
		font-size: 10px;
		font-weight: 600;
		letter-spacing: 0.2em;
		text-transform: uppercase;
		color: var(--eyebrow);
		text-align: center;
	}

	.crumb-link {
		display: inline-block;
		margin-bottom: 12px;
		text-decoration: none;
	}

	.crumb-link:hover :global(.seg) {
		color: var(--eyebrow);
	}

	@media (max-width: 900px) {
		.crumb-link {
			display: none;
		}

		.flow-header {
			display: flex;
			align-items: center;
			justify-content: space-between;
			gap: 10px;
			margin-bottom: 14px;
		}

		.flow-spacer {
			width: 32px;
			height: 32px;
			flex-shrink: 0;
		}
	}

	.lede {
		font-size: 13px;
		line-height: 1.6;
		color: var(--text-secondary);
		margin-top: 8px;
		max-width: 560px;
	}

	.hw-section {
		margin-top: 34px;
	}

	.section-title {
		font-size: 17px;
		font-weight: 600;
		color: var(--text);
		letter-spacing: -0.01em;
	}

	.add-form {
		display: flex;
		align-items: flex-end;
		gap: 10px;
		flex-wrap: wrap;
		margin-top: 14px;
	}

	.add-form .grow {
		flex: 1;
		min-width: 220px;
	}

	.notice {
		margin-top: 10px;
		color: var(--sage);
		font-size: 12.5px;
	}

	/* Hairline rows — the 5h grammar: rows, not boxes. */
	.hw-rows {
		list-style: none;
		margin: 6px 0 0;
		padding: 0;
		display: flex;
		flex-direction: column;
	}

	.hw-row {
		display: flex;
		align-items: center;
		gap: 14px;
		padding: 15px 0;
		border-bottom: 1px solid var(--hairline);
	}

	.hw-row:last-child {
		border-bottom: none;
	}

	.row-body {
		flex: 1;
		min-width: 0;
	}

	.row-title {
		font-size: 14.5px;
		font-weight: 500;
		color: var(--text-rows);
	}

	.row-sub {
		font-size: 12px;
		color: var(--text-muted);
		margin-top: 2px;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.row-actions {
		display: flex;
		gap: 6px;
		flex-shrink: 0;
	}

	.hint {
		margin-top: 8px;
	}

	@media (max-width: 900px) {
		.hw-section {
			margin-top: 26px;
		}

		.section-title {
			font-size: 14.5px;
		}

		.hw-row {
			padding: 13px 0;
		}

		.row-title {
			font-size: 13px;
		}

		.row-sub {
			font-size: 10.5px;
		}
	}
</style>
