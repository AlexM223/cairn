<script lang="ts">
	/**
	 * Collaborators — the owner-only "share this wallet" surface for a multisig
	 * (collaborative custody, docs/COLLABORATIVE-CUSTODY-PLAN.md §3/§6). Lists who
	 * the wallet is shared with, lets the owner share it with an accepted contact
	 * as a viewer (watch-only) or cosigner (can co-sign), optionally scoping a
	 * cosigner to specific keys, and lets the owner revoke a share.
	 *
	 * UI-only on top of the tested backend:
	 *   GET    /api/wallets/multisig/:id/shares            -> { collaborators }
	 *   POST   /api/wallets/multisig/:id/shares            { contactUserId, role, keyIds? } -> { collaborators }
	 *   DELETE /api/wallets/multisig/:id/shares/:shareId   -> { collaborators }
	 *
	 * The page's +page.server.ts already gated this component behind
	 * owner + team-mode, so it never renders for a viewer/cosigner or in solo mode.
	 */
	import Icon from '$lib/components/Icon.svelte';
	import Modal from '$lib/components/heartwood/Modal.svelte';
	import Term from '$lib/components/Term.svelte';
	import type { Collaborator, ShareRole } from '$lib/server/multisigShares';

	interface ContactOption {
		userId: number;
		displayName: string;
		email: string;
	}

	let {
		multisigId,
		keys,
		threshold,
		contacts,
		initialCollaborators
	}: {
		multisigId: number;
		keys: { id: number; name: string }[];
		threshold: number;
		contacts: ContactOption[];
		initialCollaborators: Collaborator[];
	} = $props();

	// Server-seeded once, then kept live from each mutation's { collaborators }
	// reply — same "the API hands back the fresh list" pattern the /shares routes
	// use, so we never re-run the page's heavy scan just to reflect a share change.
	// Intentionally captures the initial prop value; subsequent updates come from
	// the API, not from a changing prop.
	// svelte-ignore state_referenced_locally
	let collaborators = $state<Collaborator[]>([...initialCollaborators]);

	let busy = $state(false);
	let error = $state<string | null>(null);

	// Share form state.
	let selectedContactId = $state<number | ''>('');
	let role = $state<ShareRole>('viewer');
	let selectedKeyIds = $state<number[]>([]);

	// Keys already handed to some other collaborator can't be reassigned (the
	// backend rejects it as 'bad_keys'); disable them in the picker so the owner
	// never picks a losing option.
	const assignedKeyIds = $derived(
		new Set(collaborators.flatMap((c) => c.assignedKeyIds))
	);

	// Only contacts who aren't already collaborators appear in the picker — to
	// change an existing collaborator's role, revoke and re-share (keeps the form
	// unambiguous; the backend upsert would otherwise silently mutate a row).
	const sharedUserIds = $derived(new Set(collaborators.map((c) => c.userId)));
	const availableContacts = $derived(contacts.filter((c) => !sharedUserIds.has(c.userId)));

	const roleLabel: Record<ShareRole, string> = {
		viewer: 'Watch only',
		cosigner: 'Can co-sign'
	};

	function keyName(id: number): string {
		return keys.find((k) => k.id === id)?.name ?? `Key #${id}`;
	}

	function toggleKey(id: number) {
		selectedKeyIds = selectedKeyIds.includes(id)
			? selectedKeyIds.filter((k) => k !== id)
			: [...selectedKeyIds, id];
	}

	function resetForm() {
		selectedContactId = '';
		role = 'viewer';
		selectedKeyIds = [];
	}

	// Switching back to viewer drops any staged key scope — a viewer holds no keys.
	$effect(() => {
		if (role === 'viewer' && selectedKeyIds.length) selectedKeyIds = [];
	});

	async function share(e: SubmitEvent) {
		e.preventDefault();
		if (busy || selectedContactId === '') return;
		busy = true;
		error = null;
		try {
			const res = await fetch(`/api/wallets/multisig/${multisigId}/shares`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					contactUserId: selectedContactId,
					role,
					keyIds: role === 'cosigner' ? selectedKeyIds : []
				})
			});
			const body = await res.json().catch(() => null);
			if (!res.ok) throw new Error(body?.error || 'Could not share this wallet.');
			collaborators = body.collaborators ?? collaborators;
			resetForm();
		} catch (err) {
			error = err instanceof Error ? err.message : 'Could not share this wallet.';
		} finally {
			busy = false;
		}
	}

	// Revoking is a real access change, so it goes through the shared confirm Modal.
	let revokeTarget = $state<Collaborator | null>(null);
	let revokeOpen = $state(false);

	function askRevoke(c: Collaborator) {
		revokeTarget = c;
		revokeOpen = true;
	}

	async function onRevokeConfirmed() {
		const target = revokeTarget;
		if (!target) return;
		busy = true;
		error = null;
		try {
			const res = await fetch(`/api/wallets/multisig/${multisigId}/shares/${target.shareId}`, {
				method: 'DELETE'
			});
			const body = await res.json().catch(() => null);
			if (!res.ok) throw new Error(body?.error || 'Could not remove this collaborator.');
			collaborators = body.collaborators ?? collaborators.filter((c) => c.shareId !== target.shareId);
		} catch (err) {
			error = err instanceof Error ? err.message : 'Could not remove this collaborator.';
		} finally {
			busy = false;
			revokeTarget = null;
		}
	}
</script>

<section class="hw-section" aria-label="Collaborators">
	<div class="hw-section-head">
		<h2 class="hw-section-title">Collaborators</h2>
		<span class="hint">
			<Term
				tip="Sharing lets someone else watch this wallet, or hold one of its keys and co-sign. It never gives away spending power on its own — spending always needs your {threshold}-of-{keys.length} quorum."
				>Share this wallet with a contact.</Term
			>
		</span>
	</div>

	{#if error}<div class="form-error" role="alert">{error}</div>{/if}

	<!-- current collaborators -->
	{#if collaborators.length}
		<ul class="collab-rows">
			{#each collaborators as c (c.shareId)}
				<li class="collab-row">
					<div class="collab-body">
						<div class="collab-title">{c.displayName}</div>
						<div class="collab-sub">
							{c.email} · {roleLabel[c.role]}
							{#if c.role === 'cosigner' && c.assignedKeyIds.length}
								· holds {c.assignedKeyIds.map(keyName).join(', ')}
							{/if}
						</div>
					</div>
					<button
						type="button"
						class="btn btn-ghost btn-sm"
						disabled={busy}
						onclick={() => askRevoke(c)}
					>
						Remove
					</button>
				</li>
			{/each}
		</ul>
	{:else}
		<p class="hint collab-empty">
			This wallet isn't shared with anyone yet. Share it with a contact below to let them watch it,
			or hand them one of its keys to co-sign.
		</p>
	{/if}

	<!-- share form -->
	{#if availableContacts.length}
		<form class="share-form" onsubmit={share}>
			<div class="share-line">
				<div class="field grow">
					<label class="label" for="collab-contact">Contact</label>
					<select
						class="input"
						id="collab-contact"
						bind:value={selectedContactId}
						disabled={busy}
					>
						<option value="" disabled>Choose a contact…</option>
						{#each availableContacts as contact (contact.userId)}
							<option value={contact.userId}>{contact.displayName} ({contact.email})</option>
						{/each}
					</select>
				</div>
				<div class="field">
					<label class="label" for="collab-role">Access</label>
					<select class="input" id="collab-role" bind:value={role} disabled={busy}>
						<option value="viewer">Watch only</option>
						<option value="cosigner">Can co-sign</option>
					</select>
				</div>
			</div>

			<p class="role-note">
				{#if role === 'viewer'}
					They'll see this wallet's balance and history, but can't build or sign anything.
				{:else}
					They can help build and co-sign transactions. Optionally assign the specific key(s)
					they hold — leave this blank to decide later.
				{/if}
			</p>

			{#if role === 'cosigner' && keys.length}
				<fieldset class="key-scope">
					<legend class="label">Keys they hold (optional)</legend>
					<div class="key-scope-list">
						{#each keys as key (key.id)}
							{@const takenByOther = assignedKeyIds.has(key.id)}
							<label class="key-check" class:disabled={takenByOther}>
								<input
									type="checkbox"
									checked={selectedKeyIds.includes(key.id)}
									disabled={busy || takenByOther}
									onchange={() => toggleKey(key.id)}
								/>
								<span>{key.name}</span>
								{#if takenByOther}
									<span class="key-taken">already assigned</span>
								{/if}
							</label>
						{/each}
					</div>
				</fieldset>
			{/if}

			<div class="share-actions">
				<button class="btn btn-primary btn-sm" disabled={busy || selectedContactId === ''}>
					{#if busy}<span class="spinner"></span>{/if}
					Share wallet
				</button>
			</div>
		</form>
	{:else if !collaborators.length}
		<p class="hint">
			You don't have any contacts to share with yet. Add someone in
			<a href="/settings/contacts">Settings › Contacts</a> first.
		</p>
	{:else if contacts.length && availableContacts.length === 0}
		<p class="hint">
			Every one of your contacts already has access. Add another in
			<a href="/settings/contacts">Settings › Contacts</a> to share more widely.
		</p>
	{/if}
</section>

<Modal
	bind:open={revokeOpen}
	title={revokeTarget ? `Remove ${revokeTarget.displayName}?` : ''}
	message={revokeTarget
		? `${revokeTarget.displayName} will lose access to this wallet, and any keys assigned to them are released. Transactions already in progress that they were part of are unaffected.`
		: ''}
	confirmLabel="Remove collaborator"
	onConfirm={onRevokeConfirmed}
	onCancel={() => (revokeTarget = null)}
/>

<style>
	/* Mirrors the detail page's hairline-section grammar (rows, not boxes). The
	   .hw-section / .hw-section-head / .hw-section-title / .btn / .input / .field /
	   .label / .form-error / .hint / .spinner classes are global; only this
	   section's own layout is scoped here. */

	.collab-rows {
		list-style: none;
		margin: 4px 0 0;
		padding: 0;
		display: flex;
		flex-direction: column;
	}

	.collab-row {
		display: flex;
		align-items: center;
		gap: 14px;
		padding: 14px 0;
		border-bottom: 1px solid var(--hairline);
	}

	.collab-row:last-child {
		border-bottom: none;
	}

	.collab-body {
		flex: 1;
		min-width: 0;
	}

	.collab-title {
		font-size: 14.5px;
		font-weight: 500;
		color: var(--text-rows);
	}

	.collab-sub {
		font-size: 12px;
		color: var(--text-muted);
		margin-top: 2px;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.collab-empty {
		margin-top: 2px;
		max-width: 560px;
		line-height: 1.6;
	}

	.share-form {
		display: flex;
		flex-direction: column;
		gap: 12px;
		margin-top: 18px;
		padding-top: 18px;
		border-top: 1px solid var(--hairline);
	}

	.share-line {
		display: flex;
		gap: 12px;
		flex-wrap: wrap;
		align-items: flex-end;
	}

	.share-line .grow {
		flex: 1;
		min-width: 220px;
	}

	.field {
		display: flex;
		flex-direction: column;
		gap: 5px;
	}

	.role-note {
		font-size: 12.5px;
		line-height: 1.6;
		color: var(--text-secondary);
		margin: 0;
		max-width: 560px;
	}

	.key-scope {
		border: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.key-scope-list {
		display: flex;
		flex-wrap: wrap;
		gap: 10px 18px;
	}

	.key-check {
		display: inline-flex;
		align-items: center;
		gap: 7px;
		font-size: 13px;
		color: var(--text-rows);
		cursor: pointer;
	}

	.key-check.disabled {
		color: var(--text-faint);
		cursor: not-allowed;
	}

	.key-taken {
		font-size: 11px;
		color: var(--text-faint);
	}

	.share-actions {
		display: flex;
		gap: 8px;
	}

	@media (max-width: 900px) {
		.share-line {
			flex-direction: column;
			align-items: stretch;
		}

		.share-line .field {
			min-width: 0;
		}
	}
</style>
