<script lang="ts">
	import Icon from './Icon.svelte';

	// Generic horizontal step indicator. Given an ordered list of steps and the
	// key of the current one, it renders numbered circles with connecting lines:
	// completed steps get an accent fill + check, the current step is
	// highlighted, and future steps are muted. Purely presentational — it
	// derives "done/current/future" from position, never mutates state.
	let {
		steps,
		current
	}: {
		steps: { key: string; label: string }[];
		current: string;
	} = $props();

	const currentIndex = $derived(Math.max(0, steps.findIndex((s) => s.key === current)));

	function stateOf(i: number): 'done' | 'current' | 'future' {
		if (i < currentIndex) return 'done';
		if (i === currentIndex) return 'current';
		return 'future';
	}
</script>

<nav aria-label="Progress">
	<ol class="stepper">
		{#each steps as step, i (step.key)}
			{@const state = stateOf(i)}
			<li
				class="step"
				class:done={state === 'done'}
				class:current={state === 'current'}
				aria-current={state === 'current' ? 'step' : undefined}
			>
				{#if i > 0}
					<span class="line" class:filled={i <= currentIndex} aria-hidden="true"></span>
				{/if}
				<span class="marker">
					<span class="circle">
						{#if state === 'done'}
							<Icon name="check" size={14} strokeWidth={2.25} />
						{:else}
							<span class="num">{i + 1}</span>
						{/if}
					</span>
					<span class="label">{step.label}</span>
				</span>
			</li>
		{/each}
	</ol>
</nav>

<style>
	.stepper {
		display: flex;
		align-items: flex-start;
		list-style: none;
		margin: 0;
		padding: 0;
	}

	.step {
		position: relative;
		flex: 1;
		display: flex;
		justify-content: center;
		min-width: 0;
	}

	/* Connecting line runs from the previous circle to this one. It sits behind
	   the marker, anchored to the circle's vertical center (14px = half of the
	   28px circle). */
	.line {
		position: absolute;
		top: 14px;
		right: 50%;
		left: -50%;
		height: 2px;
		margin: 0 20px;
		background: var(--border);
		transform: translateY(-1px);
	}

	.line.filled {
		background: var(--accent);
	}

	.marker {
		position: relative;
		z-index: 1;
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 7px;
		text-align: center;
		min-width: 0;
	}

	.circle {
		width: 28px;
		height: 28px;
		flex-shrink: 0;
		border-radius: 50%;
		display: flex;
		align-items: center;
		justify-content: center;
		background: var(--surface-elevated);
		border: 1.5px solid var(--border);
		color: var(--text-muted);
		font-size: 12.5px;
		font-weight: 600;
		font-variant-numeric: tabular-nums;
		transition:
			background 160ms var(--ease),
			border-color 160ms var(--ease),
			color 160ms var(--ease);
	}

	.step.done .circle {
		background: var(--accent);
		border-color: var(--accent);
		color: #201409;
	}

	.step.current .circle {
		border-color: var(--accent);
		color: var(--accent);
		background: var(--accent-muted);
		box-shadow: 0 0 0 4px var(--accent-muted);
	}

	.label {
		font-size: 12.5px;
		font-weight: 500;
		color: var(--text-muted);
		line-height: 1.3;
		max-width: 100%;
	}

	.step.current .label {
		color: var(--text);
	}

	.step.done .label {
		color: var(--text-secondary);
	}

	@media (max-width: 520px) {
		.label {
			font-size: 11px;
			/* Keep labels from overflowing at 375px: truncate to a single line. */
			max-width: 62px;
			overflow: hidden;
			text-overflow: ellipsis;
			white-space: nowrap;
		}

		.line {
			margin: 0 8px;
		}
	}
</style>
