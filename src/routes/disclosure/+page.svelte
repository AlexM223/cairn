<script lang="ts">
	import { enhance } from '$app/forms';
	import GroveField from '$lib/components/heartwood/GroveField.svelte';
	import HeartwoodMark from '$lib/components/heartwood/HeartwoodMark.svelte';
	import Icon from '$lib/components/Icon.svelte';

	let { data, form } = $props();

	let accepted = $state(false);
	let submitting = $state(false);

	// Split the disclosure into paragraphs; bold the leading UPPERCASE clause of
	// each so the screen reads as scannable points, not a wall of text.
	const paragraphs = $derived(data.disclosure.split('\n\n'));
	function leadAndRest(p: string): { lead: string | null; rest: string } {
		const m = p.match(/^([A-Z][A-Z ,'-]{4,}\.)\s*(.*)$/s);
		return m ? { lead: m[1], rest: m[2] } : { lead: null, rest: p };
	}
</script>

<svelte:head>
	<title>Operator disclosure — Heartwood</title>
</svelte:head>

<div class="screen">
	<GroveField volume="grove" />
	<div class="sheet">
		<div class="sheet-head">
			<span class="brand">
				<HeartwoodMark size={24} tone="copper" detail="simple" />
				<span class="brand-word">Heartwood</span>
			</span>
			<span class="badge badge-accent">First-run setup</span>
		</div>

		<h1 class="title">Before you invite anyone</h1>
		<p class="lede">
			You're about to run Bitcoin infrastructure for yourself and anyone you invite. Read this
			once — it sets out what you're responsible for, and what Heartwood is not.
		</p>

		<div class="disclosure">
			{#each paragraphs as p, i (i)}
				{@const parts = leadAndRest(p)}
				{#if i === 0}
					<p class="disclosure-intro">{p}</p>
				{:else}
					<p class="disclosure-p">
						{#if parts.lead}<strong>{parts.lead}</strong> {/if}{parts.rest}
					</p>
				{/if}
			{/each}
		</div>

		<div class="tos-tip">
			<Icon name="info" size={15} />
			<span>
				We recommend establishing your own terms of service with your users. Heartwood ships a
				customizable <strong>user agreement</strong> you can edit in
				<em>Settings → User Agreement</em> — <a href="/terms" target="_blank" rel="noopener"
					>preview the current version</a
				>.
			</span>
		</div>

		<form method="POST" use:enhance={() => {
			submitting = true;
			return async ({ update }) => {
				submitting = false;
				await update();
			};
		}}>
			{#if form?.error}
				<div class="form-error" role="alert">{form.error}</div>
			{/if}

			<label class="accept">
				<input type="checkbox" name="accept" bind:checked={accepted} />
				<span>I understand I am operating Bitcoin infrastructure and accept these responsibilities.</span>
			</label>

			<button class="btn btn-primary continue" disabled={!accepted || submitting}>
				{#if submitting}<span class="spinner"></span>{/if}
				Accept and continue
				<Icon name="arrow-right" size={15} />
			</button>
		</form>
	</div>
</div>

<style>
	.screen {
		position: relative;
		min-height: 100vh;
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 40px 20px;
	}

	/* No card box — a centered column directly on the grove field. */
	.sheet {
		position: relative;
		z-index: 1;
		width: 100%;
		max-width: 620px;
		display: flex;
		flex-direction: column;
		gap: 18px;
	}

	.sheet-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
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
		font-size: 28px;
		font-weight: 600;
		letter-spacing: -0.015em;
		color: var(--text-hero);
	}

	.lede {
		font-size: 14px;
		line-height: 1.6;
		color: var(--text-secondary);
		margin-top: -8px;
	}

	/* The scrollable legal text sits between hairline rules, unboxed. */
	.disclosure {
		display: flex;
		flex-direction: column;
		gap: 12px;
		padding: 18px 2px;
		border-top: 1px solid var(--hairline);
		border-bottom: 1px solid var(--hairline);
		max-height: 42vh;
		overflow-y: auto;
	}

	.disclosure-intro {
		font-size: 14px;
		font-weight: 500;
		color: var(--text);
		line-height: 1.6;
	}

	.disclosure-p {
		font-size: 13px;
		line-height: 1.65;
		color: var(--text-secondary);
	}

	.disclosure-p strong {
		color: var(--text);
		font-weight: 600;
	}

	.tos-tip {
		display: flex;
		gap: 10px;
		align-items: flex-start;
		font-size: 12.5px;
		line-height: 1.6;
		color: var(--text-secondary);
		background: var(--accent-muted);
		border-radius: 18px;
		padding: 12px 16px;
	}

	.tos-tip :global(svg) {
		color: var(--accent);
		flex-shrink: 0;
		margin-top: 1px;
	}

	.tos-tip strong {
		color: var(--text);
	}

	form {
		display: flex;
		flex-direction: column;
		gap: 16px;
	}

	.accept {
		display: flex;
		align-items: flex-start;
		gap: 11px;
		padding: 14px 18px;
		border: 1px solid var(--border-ghost);
		border-radius: 18px;
		font-size: 13.5px;
		line-height: 1.5;
		cursor: pointer;
		transition: border-color 120ms var(--ease);
	}

	.accept:hover {
		border-color: var(--accent);
	}

	.accept input {
		margin-top: 2px;
		width: 17px;
		height: 17px;
		accent-color: var(--accent);
		flex-shrink: 0;
		cursor: pointer;
	}

	.continue {
		align-self: flex-end;
	}
</style>
