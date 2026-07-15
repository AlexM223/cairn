<script lang="ts">
	// R3 (docs/UX-PSYCHOLOGY-RESEARCH-2026-07-15.md, cairn-avzs): "Sending in
	// 5s — Cancel". Replaces the Confirm step's primary button while armed.
	// The state machine (broadcastGrace.ts) is plain TS and unit-tested with
	// fake timers; this component only mirrors it into Svelte state and draws
	// the ring/countdown/Cancel/Send-now UI.
	//
	// Contract with the caller: `onbroadcast` fires at most once, exactly when
	// the window elapses or the user taps "Send now" — never on cancel, never
	// after this component unmounts. The $effect cleanup below calls
	// `grace.destroy()` on unmount, which is what makes "navigate away during
	// the window" behave as a cancel (R3): a pending setTimeout in a torn-down
	// component's closure is cleared before it could ever call `onbroadcast`.
	import { BroadcastGrace, type GraceStatus, GRACE_DURATION_MS } from './broadcastGrace';
	import Icon from '$lib/components/Icon.svelte';

	let {
		label,
		disabled = false,
		durationMs = GRACE_DURATION_MS,
		onbroadcast,
		counting = $bindable(false)
	}: {
		/** The normal primary-button label (sendCtaLabel(...) — "Broadcast — $x.xx"). */
		label: string;
		/** Disables the primary button (mirrors the page's own `broadcasting` gate). */
		disabled?: boolean;
		durationMs?: number;
		/** Called once the grace window elapses or is skipped — the caller's
		 *  existing `broadcast()` goes here unchanged. */
		onbroadcast: () => void;
		/** True while the window is counting — bindable so the caller can also
		 *  disable its own "Back" button during the window (nothing about the
		 *  draft should be navigable away from mid-countdown). */
		counting?: boolean;
	} = $props();

	let status = $state<GraceStatus>('idle');
	// svelte-ignore state_referenced_locally — durationMs is a construction-
	// time parameter for the engine below, not a live binding; a caller that
	// changes it mid-flight would need a new component instance anyway.
	let secondsLeft = $state(Math.ceil(durationMs / 1000));

	// svelte-ignore state_referenced_locally — same: captured once, at
	// construction, intentionally.
	const grace = new BroadcastGrace({
		durationMs,
		onFire: () => onbroadcast(),
		onChange: () => {
			status = grace.status;
			secondsLeft = grace.secondsLeft;
			counting = status === 'counting';
		}
	});

	// Unmount / navigate-away safety net — see the file header. Also covers a
	// prop-driven remount (e.g. resuming a different draft): a fresh
	// BroadcastGrace instance is created per mount since the class is
	// constructed in the script body, not in the effect.
	$effect(() => {
		return () => grace.destroy();
	});

	// prefers-reduced-motion: detected client-side (matchMedia doesn't exist
	// during SSR), same pattern as FirstSyncGrowth.svelte. The ring is CSS-
	// animation-driven for smoothness; under reduced motion we skip it
	// entirely rather than rely on the global animation-duration override,
	// which would otherwise desync the ring's visual completion from the
	// real (unaffected) setTimeout firing time.
	let reducedMotion = $state(false);
	$effect(() => {
		reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
	});

	function arm() {
		if (disabled) return;
		grace.start();
	}
	function cancel() {
		grace.cancel();
	}
	function sendNow() {
		grace.skip();
	}

	const R = 12;
	const C = 2 * Math.PI * R;
</script>

{#if status === 'counting'}
	<div class="grace" role="group" aria-label="Broadcast pending">
		<div class="grace-visual" aria-hidden="true">
			{#if reducedMotion}
				<span class="grace-digit">{secondsLeft}</span>
			{:else}
				<svg viewBox="0 0 30 30" width="26" height="26" class="grace-ring">
					<circle cx="15" cy="15" r={R} class="grace-track" />
					<circle
						cx="15"
						cy="15"
						r={R}
						class="grace-arc"
						style:stroke-dasharray={C}
						style:--grace-duration="{durationMs}ms"
					/>
				</svg>
			{/if}
		</div>
		<span class="grace-copy" aria-hidden="true">Sending in {secondsLeft}s</span>
		<!-- One calm, non-repeating announcement for AT — the visual digit above
		     updates every tick, but re-announcing a live region every second is
		     the confirmation-dialog-fatigue failure mode (F4) applied to screen
		     readers. -->
		<span class="sr-only" role="status">
			Sending in {durationMs / 1000} seconds. Press Cancel to stop it, or Send now to send
			immediately.
		</span>
		<button type="button" class="btn btn-ghost grace-cancel" onclick={cancel}> Cancel </button>
		<button type="button" class="btn btn-secondary btn-sm grace-skip" onclick={sendNow}>
			Send now
		</button>
	</div>
{:else}
	<button type="button" class="btn btn-primary pill-lg" onclick={arm} {disabled}>
		{#if status === 'firing'}
			<span class="spinner"></span> Broadcasting…
		{:else}
			{label}
			<Icon name="arrow-right" size={15} />
		{/if}
	</button>
{/if}

<style>
	.sr-only {
		position: absolute;
		width: 1px;
		height: 1px;
		padding: 0;
		margin: -1px;
		overflow: hidden;
		clip: rect(0, 0, 0, 0);
		white-space: nowrap;
		border: 0;
	}

	/* Calm, not alarmed: a hairline panel in the ordinary money grammar — no
	   amber, no red, no pulsing. This is process, not a warning (manifesto
	   §5 "animate growth and process; never animate alarm"). */
	.grace {
		display: flex;
		align-items: center;
		gap: 12px;
		padding: 10px 16px;
		border: 1px solid var(--border-control);
		border-radius: 999px;
		background: var(--bg-input);
		flex-wrap: wrap;
	}

	.grace-visual {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 26px;
		height: 26px;
		flex-shrink: 0;
	}

	.grace-digit {
		font-family: var(--font-ui);
		font-size: 14px;
		font-weight: 600;
		font-variant-numeric: tabular-nums;
		color: var(--text);
	}

	.grace-ring {
		display: block;
		transform: rotate(-90deg);
		overflow: visible;
	}

	.grace-track {
		fill: none;
		stroke: var(--border-control);
		stroke-width: 2;
	}

	.grace-arc {
		fill: none;
		stroke: var(--accent);
		stroke-width: 2;
		stroke-linecap: round;
		stroke-dashoffset: 0;
		/* Unwinds once, linearly, over the real grace duration — decoupled
		   from the JS tick interval (cosmetic only). forwards holds the fully-
		   unwound state if the component is still mounted at the deadline. */
		animation: hwGraceUnwind var(--grace-duration) linear forwards;
	}

	@keyframes hwGraceUnwind {
		from {
			stroke-dashoffset: 0;
		}
		to {
			/* stroke-dasharray is set inline to the circle's circumference (C);
			   offsetting by that same value fully retracts the arc. */
			stroke-dashoffset: 75.4;
		}
	}

	.grace-copy {
		font-size: 14px;
		color: var(--text-secondary);
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
	}

	.grace-cancel {
		margin-left: auto;
	}

	@media (max-width: 480px) {
		.grace {
			justify-content: center;
		}
		.grace-cancel {
			margin-left: 0;
		}
	}
</style>
