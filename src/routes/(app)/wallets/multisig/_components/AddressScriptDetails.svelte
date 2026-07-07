<script lang="ts">
	import CopyText from '$lib/components/CopyText.svelte';
	import Term from '$lib/components/Term.svelte';

	// The per-address "verify the details" disclosure (cairn-h73): fetches the
	// scripts and per-key paths for ONE address on demand — the page never ships
	// script material for addresses nobody expands.
	interface KeyPath {
		id: number;
		name: string;
		fingerprint: string;
		basePath: string;
		fullPath: string;
	}
	interface Detail {
		address: string;
		chain: 0 | 1;
		index: number;
		scriptType: string;
		witnessScript: string | null;
		redeemScript: string | null;
		sortedPubkeys: string[];
		keys: KeyPath[];
	}

	let { multisigId, chain, index }: { multisigId: number; chain: 0 | 1; index: number } = $props();

	let detail = $state<Detail | null>(null);
	let error = $state<string | null>(null);

	$effect(() => {
		// Re-fetch if the props ever change; rows are keyed, so in practice this
		// runs once per opened disclosure.
		const url = `/api/wallets/multisig/${multisigId}/address-detail?chain=${chain}&index=${index}`;
		let cancelled = false;
		detail = null;
		error = null;
		(async () => {
			try {
				const res = await fetch(url);
				const data = await res.json();
				if (cancelled) return;
				if (!res.ok) error = data.error ?? 'Could not load the address details.';
				else detail = data as Detail;
			} catch {
				if (!cancelled) error = 'Could not load the address details.';
			}
		})();
		return () => {
			cancelled = true;
		};
	});
</script>

<div class="asd">
	{#if error}
		<div class="form-error" role="alert">{error}</div>
	{:else if !detail}
		<div class="asd-loading"><span class="spinner"></span> Deriving scripts…</div>
	{:else}
		<p class="asd-framing">
			These details let you verify this address on any other wallet tool: load your backup into
			Sparrow or Caravan, look up address <span class="mono">{detail.chain}/{detail.index}</span>,
			and everything below must match exactly — proving the address is built from your keys alone.
		</p>

		<div class="asd-section">
			<span class="asd-label">Derivation paths</span>
			<ul class="asd-keys">
				{#each detail.keys as k (k.id)}
					<li>
						<span class="asd-key-name truncate">{k.name}</span>
						{#if k.fingerprint !== '00000000'}
							<span class="asd-key-fp mono">{k.fingerprint}</span>
						{/if}
						<CopyText value={k.fullPath} />
					</li>
				{/each}
			</ul>
		</div>

		{#if detail.witnessScript}
			<div class="asd-section">
				<span class="asd-label">
					<Term
						tip="The actual M-of-N script this address commits to. Money at this address can only move when enough of your keys sign against exactly this script."
						>Witness script</Term
					>
					<CopyText value={detail.witnessScript} display="copy hex" mono={false} />
				</span>
				<code class="asd-hex">{detail.witnessScript}</code>
			</div>
		{/if}

		{#if detail.redeemScript}
			<div class="asd-section">
				<span class="asd-label">
					<Term
						tip="The script this wrapped address reveals when spending — other tools must derive this exact hex from your public keys."
						>Redeem script</Term
					>
					<CopyText value={detail.redeemScript} display="copy hex" mono={false} />
				</span>
				<code class="asd-hex">{detail.redeemScript}</code>
			</div>
		{/if}

		<div class="asd-section">
			<span class="asd-label">
				<Term
					tip="Each key's one-time public key for this address, in BIP-67 sorted order — the standard order every compatible wallet uses, so the order your keys were added never changes the address."
					>Public keys (BIP-67 order)</Term
				>
			</span>
			<ul class="asd-pubkeys">
				{#each detail.sortedPubkeys as pk (pk)}
					<li><CopyText value={pk} /></li>
				{/each}
			</ul>
		</div>
	{/if}
</div>

<style>
	/* Unboxed disclosure (hairlines-not-boxes): a copper hairline on the left
	   marks the expanded region instead of a framed panel. */
	.asd {
		display: flex;
		flex-direction: column;
		gap: 12px;
		padding: 4px 0 8px 14px;
		border-left: 2px solid var(--accent-dim-2);
		font-size: 12.5px;
	}

	.asd-loading {
		display: flex;
		align-items: center;
		gap: 8px;
		color: var(--text-muted);
	}

	.asd-framing {
		color: var(--text-secondary);
		line-height: 1.6;
	}

	.asd-section {
		display: flex;
		flex-direction: column;
		gap: 6px;
		min-width: 0;
	}

	.asd-label {
		display: flex;
		align-items: center;
		gap: 10px;
		font-size: 11px;
		font-weight: 600;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--text-muted);
	}

	.asd-keys,
	.asd-pubkeys {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	.asd-keys li {
		display: flex;
		align-items: center;
		gap: 10px;
		min-width: 0;
	}

	.asd-key-name {
		color: var(--text);
		font-weight: 500;
		max-width: 160px;
	}

	.asd-key-fp {
		color: var(--text-muted);
		font-size: 11px;
	}

	.asd-hex {
		font-family: var(--font-mono, monospace);
		font-size: 11.5px;
		line-height: 1.6;
		word-break: break-all;
		color: var(--text-secondary);
		background: var(--bg-input);
		border-radius: var(--radius-control);
		padding: 8px 10px;
	}

	.asd-pubkeys li {
		min-width: 0;
	}
</style>
