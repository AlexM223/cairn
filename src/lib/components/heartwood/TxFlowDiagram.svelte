<script lang="ts">
	/**
	 * TxFlowDiagram — CSS-only "Sankey-lite" value-flow for the tx detail page
	 * (cairn-6efi.8, Explorer redesign Wave 3). Two proportional rails — inputs on
	 * top, outputs + the "→ the miner" fee on the bottom — with widths tied to
	 * value. Built entirely from the already-decoded transaction the page loaded
	 * (zero new chain calls); all geometry is precomputed by the pure computeTxFlow
	 * (txFlow.ts), so this component is presentation only.
	 *
	 * Discipline:
	 *   • Motion is decorative (a slow gradient drift on the connective band) and
	 *     disabled under prefers-reduced-motion — the proportions are values, not
	 *     animations, so the viz is fully correct with motion off.
	 *   • Mobile-safe: rails are percentage/flex based so they never force page
	 *     scroll; the whole viz still lives in an overflow-x:auto shell as a belt-
	 *     and-braces guard for very narrow columns.
	 *   • Absence reads as absence: the parent only mounts this when computeTxFlow
	 *     returns non-null, and the optional fee sliver renders only when a mempool
	 *     position could be derived.
	 */
	import { formatBtc, formatSats, formatFeeRate, truncateMiddle } from '$lib/format';
	import type { TxFlow, FlowBand, FeePosition } from './txFlow';

	let {
		flow,
		feePosition = null
	}: {
		flow: TxFlow;
		/** Where this tx's fee rate sits in the mempool; null → sliver omitted. */
		feePosition?: FeePosition | null;
	} = $props();

	function bandLabel(b: FlowBand): string {
		if (b.kind === 'fee') return 'Fee → the miner';
		if (b.kind === 'more') return `+${b.count} more`;
		if (b.isCoinbaseSource) return 'New coins';
		if (b.address) return truncateMiddle(b.address, 6, 6);
		if (b.scriptType === 'op_return') return 'OP_RETURN';
		return 'Unknown';
	}

	function bandTitle(b: FlowBand): string {
		const val = `${formatBtc(b.value)} BTC (${formatSats(b.value)} sats)`;
		const pct = `${(b.pct * 100).toFixed(b.pct < 0.01 ? 2 : 1)}%`;
		if (b.kind === 'fee') return `Fee to the miner — ${val} · ${pct}`;
		if (b.kind === 'more') return `${b.count} smaller entries — ${val} · ${pct}`;
		if (b.isCoinbaseSource) return `Newly minted coins — ${val}`;
		const who = b.address ?? (b.scriptType === 'op_return' ? 'OP_RETURN data' : 'unknown');
		const tags = [b.isChange ? 'change' : null, b.isYours ? 'yours' : null]
			.filter(Boolean)
			.join(', ');
		return `${who} — ${val} · ${pct}${tags ? ` · ${tags}` : ''}`;
	}

	// Right rail = outputs followed by the fee band (when present).
	const rightBands = $derived<FlowBand[]>(flow.fee ? [...flow.outputs, flow.fee] : flow.outputs);

	const inLabel = $derived(
		flow.coinbase
			? 'newly minted'
			: `${flow.inputs.reduce((n, b) => n + b.count, 0)} input${
					flow.inputs.reduce((n, b) => n + b.count, 0) === 1 ? '' : 's'
				}`
	);
	const outLabel = $derived(
		`${flow.outputs.reduce((n, b) => n + b.count, 0)} output${
			flow.outputs.reduce((n, b) => n + b.count, 0) === 1 ? '' : 's'
		}`
	);

	const feeAheadPct = $derived(feePosition ? Math.round(feePosition.ahead * 100) : 0);
</script>

<figure class="txflow" aria-label="Value flow from inputs to outputs and the miner fee">
	<figcaption class="flow-cap">
		<span class="section-eyebrow">Value flow</span>
		<span class="flow-sub">{inLabel} → {outLabel}{flow.fee ? ' · fee to the miner' : ''}</span>
	</figcaption>

	<div class="rail-shell">
		<div class="rails">
			<div class="rail rail-in" role="list" aria-label="Inputs">
				{#each flow.inputs as b, i (i)}
					<span
						class="seg seg-in"
						class:yours={b.isYours}
						class:more={b.kind === 'more'}
						class:coinbase={b.isCoinbaseSource}
						style:flex-grow={b.value || 0.0001}
						title={bandTitle(b)}
						role="listitem"
					>
						<span class="seg-label">{bandLabel(b)}</span>
					</span>
				{/each}
			</div>

			<div class="links" aria-hidden="true">
				<span class="link-fade"></span>
			</div>

			<div class="rail rail-out" role="list" aria-label="Outputs and fee">
				{#each rightBands as b, i (i)}
					<span
						class="seg seg-out"
						class:yours={b.isYours}
						class:change={b.isChange}
						class:more={b.kind === 'more'}
						class:fee={b.kind === 'fee'}
						style:flex-grow={b.value || 0.0001}
						title={bandTitle(b)}
						role="listitem"
					>
						<span class="seg-label">{bandLabel(b)}</span>
					</span>
				{/each}
			</div>
		</div>
	</div>

	{#if feePosition}
		<div class="feepos" aria-label="This fee rate compared to the mempool">
			<div class="feepos-head">
				<span class="feepos-cap">Fee rate vs. what's waiting</span>
				<span class="feepos-ahead"
					>{feeAheadPct}% of pending bytes pay more</span
				>
			</div>
			<div class="feepos-track">
				<span
					class="feepos-marker"
					style:left="{feePosition.pos * 100}%"
					title="{formatFeeRate(feePosition.feeRate)} — {feeAheadPct}% of the mempool pays a higher rate"
				></span>
			</div>
			<div class="feepos-scale">
				<span class="tabular">{formatFeeRate(feePosition.min)}</span>
				<span class="tabular">{formatFeeRate(feePosition.max)}</span>
			</div>
		</div>
	{/if}
</figure>

<style>
	.txflow {
		margin: 0;
		padding: 20px 0 4px;
	}

	.flow-cap {
		display: flex;
		align-items: baseline;
		gap: 12px;
		flex-wrap: wrap;
		margin-bottom: 12px;
	}

	.section-eyebrow {
		font-size: 11px;
		font-weight: 600;
		letter-spacing: 0.18em;
		text-transform: uppercase;
		color: var(--eyebrow-path);
	}

	.flow-sub {
		font-size: 12.5px;
		color: var(--text-muted);
	}

	/* Belt-and-braces: rails are flex/%-based and fit any column, but a very
	   narrow parent can still scroll the viz inside its own shell rather than the
	   page (no horizontal page scroll at 375px). */
	.rail-shell {
		overflow-x: auto;
		overflow-y: hidden;
	}

	.rails {
		display: flex;
		flex-direction: column;
		gap: 0;
		min-width: 240px;
	}

	.rail {
		display: flex;
		width: 100%;
		gap: 3px;
		height: 34px;
	}

	.seg {
		position: relative;
		display: flex;
		align-items: center;
		justify-content: center;
		min-width: 2px;
		flex-basis: 0;
		overflow: hidden;
		border-radius: var(--radius-badge);
		padding: 0 6px;
		background: var(--accent-dim-2);
		color: var(--bg-body, #17120f);
		white-space: nowrap;
	}

	.seg-label {
		font-size: 11px;
		font-weight: 600;
		overflow: hidden;
		text-overflow: ellipsis;
		font-family: var(--font-mono, monospace);
		color: color-mix(in srgb, var(--text-hero) 88%, transparent);
		pointer-events: none;
	}

	/* Inputs read cool copper; outputs warmer; fee is the sage "harvest" band. */
	.seg-in {
		background: color-mix(in srgb, var(--accent) 30%, transparent);
	}
	.seg-in.coinbase {
		background: color-mix(in srgb, var(--sage) 32%, transparent);
	}
	.seg-out {
		background: color-mix(in srgb, var(--accent-bright) 26%, transparent);
	}
	.seg-out.change {
		background: color-mix(in srgb, var(--accent) 22%, transparent);
	}
	.seg.fee {
		background: color-mix(in srgb, var(--sage) 40%, transparent);
	}
	.seg.fee .seg-label {
		color: color-mix(in srgb, var(--sage) 92%, var(--text-hero));
	}
	.seg.more {
		background: var(--accent-dim-2);
	}
	.seg.more .seg-label {
		color: var(--text-muted);
	}
	.seg.yours {
		outline: 1.5px solid var(--sage);
		outline-offset: -1.5px;
	}

	/* Connective band between the two rails — a faint gradient that drifts slowly.
	   Purely decorative; the layout is correct with it static. */
	.links {
		height: 14px;
		position: relative;
		overflow: hidden;
	}
	.link-fade {
		position: absolute;
		inset: 0;
		background: linear-gradient(
			90deg,
			color-mix(in srgb, var(--accent) 18%, transparent),
			color-mix(in srgb, var(--sage) 16%, transparent),
			color-mix(in srgb, var(--accent-bright) 18%, transparent)
		);
		background-size: 220% 100%;
		-webkit-mask-image: linear-gradient(180deg, rgba(0, 0, 0, 0.55), transparent);
		mask-image: linear-gradient(180deg, rgba(0, 0, 0, 0.55), transparent);
		animation: link-drift 9s linear infinite;
	}

	@keyframes link-drift {
		from {
			background-position: 0% 0;
		}
		to {
			background-position: 220% 0;
		}
	}

	/* ---------- fee sliver: this rate vs the mempool ---------- */
	.feepos {
		margin-top: 18px;
		padding-top: 14px;
		border-top: 1px solid var(--hairline);
	}

	.feepos-head {
		display: flex;
		justify-content: space-between;
		align-items: baseline;
		gap: 12px;
		flex-wrap: wrap;
		margin-bottom: 8px;
	}

	.feepos-cap {
		font-size: 12px;
		font-weight: 600;
		color: var(--text-secondary);
	}

	.feepos-ahead {
		font-size: 12px;
		color: var(--text-muted);
	}

	.feepos-track {
		position: relative;
		height: 8px;
		border-radius: 4px;
		background: linear-gradient(
			90deg,
			color-mix(in srgb, var(--sage) 30%, transparent),
			color-mix(in srgb, var(--accent-bright) 45%, transparent)
		);
	}

	.feepos-marker {
		position: absolute;
		top: 50%;
		width: 3px;
		height: 16px;
		border-radius: 2px;
		background: var(--text-hero);
		transform: translate(-50%, -50%);
		box-shadow: 0 0 0 2px var(--bg-body, rgba(0, 0, 0, 0.3));
	}

	.feepos-scale {
		display: flex;
		justify-content: space-between;
		margin-top: 5px;
		font-size: 11px;
		color: var(--text-muted);
	}

	@media (prefers-reduced-motion: reduce) {
		.link-fade {
			animation: none;
		}
	}

	@media (max-width: 900px) {
		.rail {
			height: 30px;
		}
		.seg-label {
			font-size: 10px;
		}
	}
</style>
