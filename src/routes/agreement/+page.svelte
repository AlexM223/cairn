<script lang="ts">
	import { enhance } from '$app/forms';
	import GroveField from '$lib/components/heartwood/GroveField.svelte';
	import HeartwoodMark from '$lib/components/heartwood/HeartwoodMark.svelte';
	import Icon from '$lib/components/Icon.svelte';

	let { data, form } = $props();

	let accepted = $state(false);
	let submitting = $state(false);

	const paragraphs = $derived(data.agreement.text.split('\n\n'));
	function leadAndRest(p: string): { lead: string | null; rest: string } {
		const m = p.match(/^([A-Z][A-Z ,'-]{4,}\.)\s*(.*)$/s);
		return m ? { lead: m[1], rest: m[2] } : { lead: null, rest: p };
	}
</script>

<svelte:head>
	<title>{data.alreadyAccepted ? 'Terms' : 'Accept the terms'} — Heartwood</title>
</svelte:head>

<div class="screen">
	<GroveField volume="grove" />
	<div class="sheet">
		<div class="sheet-head">
			<span class="brand">
				<HeartwoodMark size={24} tone="copper" detail="simple" />
				<span class="brand-word">Heartwood</span>
			</span>
			{#if !data.alreadyAccepted}
				<span class="badge badge-accent">Please review</span>
			{/if}
		</div>

		<h1 class="title">
			{data.alreadyAccepted ? 'Your agreement with this operator' : 'Before you continue'}
		</h1>
		<p class="operator">
			{#if data.hasCustomOperator}
				This instance is operated by <strong>{data.agreement.operator}</strong>.
			{:else}
				This is a self-hosted Heartwood instance, run by whoever operates it.
			{/if}
		</p>

		<div class="agreement">
			{#each paragraphs as p, i (i)}
				{@const parts = leadAndRest(p)}
				{#if i === 0}
					<p class="agreement-intro">{p}</p>
				{:else}
					<p class="agreement-p">
						{#if parts.lead}<strong>{parts.lead}</strong> {/if}{parts.rest}
					</p>
				{/if}
			{/each}
		</div>

		{#if data.alreadyAccepted}
			<div class="review-actions">
				<span class="hint">You've accepted the current terms (version {data.agreement.version}).</span>
				<a href="/" class="btn btn-secondary">Back to Heartwood</a>
			</div>
		{:else}
			<form method="POST" action="?/accept" use:enhance={() => {
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
					<span>I understand and accept these terms.</span>
				</label>

				<button class="btn btn-primary continue" disabled={!accepted || submitting}>
					{#if submitting}<span class="spinner"></span>{/if}
					Accept and continue
					<Icon name="arrow-right" size={15} />
				</button>
			</form>
		{/if}
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
		gap: 16px;
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
		font-size: 27px;
		font-weight: 600;
		letter-spacing: -0.015em;
		color: var(--text-hero);
	}

	.operator {
		font-size: 13.5px;
		color: var(--text-secondary);
		margin-top: -6px;
	}

	.operator strong {
		color: var(--text);
	}

	/* The scrollable legal text sits between hairline rules, unboxed. */
	.agreement {
		display: flex;
		flex-direction: column;
		gap: 12px;
		padding: 18px 2px;
		border-top: 1px solid var(--hairline);
		border-bottom: 1px solid var(--hairline);
		max-height: 46vh;
		overflow-y: auto;
		white-space: pre-line;
	}

	.agreement-intro {
		font-size: 14px;
		font-weight: 500;
		color: var(--text);
		line-height: 1.6;
	}

	.agreement-p {
		font-size: 13px;
		line-height: 1.65;
		color: var(--text-secondary);
	}

	.agreement-p strong {
		color: var(--text);
		font-weight: 600;
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

	.review-actions {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		flex-wrap: wrap;
	}
</style>
