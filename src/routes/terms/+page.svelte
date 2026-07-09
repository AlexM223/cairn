<script lang="ts">
	import GroveField from '$lib/components/heartwood/GroveField.svelte';
	import HeartwoodMark from '$lib/components/heartwood/HeartwoodMark.svelte';
	import Icon from '$lib/components/Icon.svelte';

	let { data } = $props();

	const agreementParas = $derived(data.agreement.text.split('\n\n'));
	function leadAndRest(p: string): { lead: string | null; rest: string } {
		const m = p.match(/^([A-Z][A-Z ,'-]{4,}\.)\s*(.*)$/s);
		return m ? { lead: m[1], rest: m[2] } : { lead: null, rest: p };
	}
</script>

<svelte:head>
	<title>Terms — Heartwood</title>
</svelte:head>

<div class="page">
	<GroveField volume="grove" />
	<header class="head">
		<a href="/" class="brand" aria-label="Heartwood home">
			<HeartwoodMark size={24} tone="copper" detail="simple" />
			<span class="brand-word">Heartwood</span>
		</a>
		<a href={data.signedIn ? '/' : '/login'} class="btn btn-ghost btn-sm">
			{data.signedIn ? 'Back to Heartwood' : 'Sign in'}
			<Icon name="arrow-right" size={13} />
		</a>
	</header>

	<h1 class="title">Terms</h1>
	<p class="lede">
		Heartwood is self-hosted software. What you're agreeing to has two parts: the terms of the
		person or organization running this instance, and the terms of the Heartwood software itself.
	</p>

	<!-- 1. Operator agreement -->
	<section class="block">
		<h2 class="block-title">
			<Icon name="shield" size={16} />
			This instance's agreement
		</h2>
		<p class="operator">Operated by <strong>{data.agreement.operator}</strong>.</p>
		<div class="prose">
			{#each agreementParas as p, i (i)}
				{@const parts = leadAndRest(p)}
				{#if i === 0}
					<p class="intro">{p}</p>
				{:else}
					<p>{#if parts.lead}<strong>{parts.lead}</strong> {/if}{parts.rest}</p>
				{/if}
			{/each}
		</div>
	</section>

	<!-- 2. Software disclaimer -->
	<section class="block">
		<h2 class="block-title">
			<Icon name="info" size={16} />
			The Heartwood software
		</h2>
		<div class="prose">
			<p>
				Heartwood is free, open-source software released under the <strong>MIT License</strong> and
				provided <strong>“as is”, without warranty of any kind</strong>, express or implied. The
				Heartwood project and its contributors are not a party to this instance, do not operate it,
				and are not responsible for how it is run or for any loss of funds.
			</p>
			<p>
				<strong>NOT A CUSTODIAN.</strong> Heartwood never holds private keys or bitcoin. It reads
				public keys to show balances and build unsigned transactions; every spend is signed on your
				own device. No one — not the operator, not the Heartwood project — can move or recover your
				funds.
			</p>
			<p>
				<strong>IRREVERSIBLE.</strong> Bitcoin transactions cannot be undone. Verify every address
				and amount on your own device before approving. <strong>NO FINANCIAL ADVICE</strong> is
				offered anywhere in this software.
			</p>
		</div>
	</section>

	<!-- 3. Privacy -->
	<section class="block">
		<h2 class="block-title">
			<Icon name="eye" size={16} />
			Privacy — what's stored, what leaves this server
		</h2>
		<div class="prose">
			<p>
				<strong>Stored on this server:</strong> your account (email and display name), your wallet
				configuration (extended <em>public</em> keys, multisig descriptors, address labels, and
				settings), transaction drafts you build, and periodic balance snapshots for the dashboard
				charts. <strong>Never</strong> your private keys or seed phrases — those live only on your
				devices.
			</p>
			<p>
				<strong>Leaves this server:</strong> to show balances and history and to broadcast
				transactions, Heartwood queries the configured Electrum server and block explorer. Those
				servers see the addresses and transactions you look up. If this instance uses public
				servers rather than the operator's own node, those third parties can associate your queries.
			</p>
			<p>
				The optional <strong>fiat estimate</strong> is off by default; only if you turn it on does
				Heartwood fetch a current bitcoin price from an external price API. Nothing else is sent
				anywhere. Heartwood includes no analytics or trackers.
			</p>
		</div>
	</section>

	<footer class="foot">
		<span class="hint">Heartwood · self-hosted Bitcoin, run by its operator, not by us.</span>
	</footer>
</div>

<style>
	.page {
		max-width: 720px;
		margin: 0 auto;
		padding: 32px 20px 64px;
	}

	.head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin-bottom: 34px;
	}

	.brand {
		display: inline-flex;
		align-items: center;
		gap: 10px;
	}

	.brand-word {
		font-family: var(--font-serif);
		font-size: 17px;
		font-weight: 600;
		letter-spacing: -0.01em;
		color: var(--text);
	}

	.title {
		font-family: var(--font-serif);
		font-size: 34px;
		font-weight: 600;
		letter-spacing: -0.015em;
		color: var(--text-hero);
	}

	.lede {
		font-size: 14.5px;
		line-height: 1.65;
		color: var(--text-secondary);
		margin: 10px 0 8px;
	}

	/* Hairlines, not boxes: each section sits between 1px rules, unboxed. */
	.block {
		padding: 26px 0;
		border-bottom: 1px solid var(--hairline);
	}

	.block:first-of-type {
		border-top: 1px solid var(--hairline);
		margin-top: 24px;
	}

	.block-title {
		display: flex;
		align-items: center;
		gap: 9px;
		font-size: 16px;
		font-weight: 600;
		margin-bottom: 12px;
	}

	.block-title :global(svg) {
		color: var(--accent);
	}

	.operator {
		font-size: 13px;
		color: var(--text-secondary);
		margin-bottom: 12px;
	}

	.operator strong {
		color: var(--text);
	}

	.prose {
		display: flex;
		flex-direction: column;
		gap: 12px;
	}

	.prose p {
		font-size: 13.5px;
		line-height: 1.7;
		color: var(--text-secondary);
	}

	.prose .intro {
		color: var(--text);
		font-weight: 500;
	}

	.prose strong {
		color: var(--text);
		font-weight: 600;
	}

	.prose em {
		font-style: normal;
		color: var(--text);
	}

	.foot {
		margin-top: 36px;
		text-align: center;
	}
</style>
