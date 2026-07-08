<script lang="ts">
	/**
	 * NavProgress — thin animated progress bar shown during SvelteKit
	 * client-side navigation (cairn-5q2a).
	 *
	 * Without this, clicking a nav link leaves the previous page on screen
	 * with zero visual feedback until the new route's data arrives — the nav
	 * *looks* frozen even though the links themselves are always clickable.
	 *
	 * Driven entirely by SvelteKit's `navigating` store: while a navigation is
	 * in flight the bar grows toward ~80% (indeterminate-style, since we don't
	 * know real progress); the moment navigation resolves it snaps to 100% and
	 * fades out. The fade-out is timed by a CSS `animationend` listener rather
	 * than a JS timer, so the bar can never unmount out of step with its own
	 * animation.
	 */
	import { navigating } from '$app/stores';

	let visible = $state(false);
	let completing = $state(false);

	$effect(() => {
		if ($navigating) {
			// A new navigation started (or one navigation replaced another):
			// restart the grow animation from the beginning.
			completing = false;
			visible = true;
		} else if (visible) {
			// The in-flight navigation just resolved — play the "snap to 100%
			// then fade" animation. onAnimationEnd unmounts the bar once it's done.
			completing = true;
		}
	});

	function onAnimationEnd(event: AnimationEvent) {
		if (event.animationName === 'nav-progress-complete') {
			visible = false;
			completing = false;
		}
	}
</script>

{#if visible}
	<div
		class="nav-progress"
		class:completing
		role="progressbar"
		aria-label="Loading"
		aria-valuetext="Loading"
		onanimationend={onAnimationEnd}
	></div>
{/if}

<style>
	/* Fixed to the viewport, not the .content column, so it reads as a global
	   "the app is working" signal above the rail and everything else. */
	.nav-progress {
		position: fixed;
		top: 0;
		left: 0;
		height: 3px;
		width: 0%;
		background: var(--accent);
		z-index: 300;
		pointer-events: none;
		animation: nav-progress-grow 2s ease-out forwards;
	}

	.nav-progress.completing {
		animation: nav-progress-complete 0.4s ease-out forwards;
	}

	@keyframes nav-progress-grow {
		from {
			width: 0%;
			opacity: 1;
		}
		to {
			width: 80%;
			opacity: 1;
		}
	}

	@keyframes nav-progress-complete {
		from {
			width: 80%;
			opacity: 1;
		}
		60% {
			width: 100%;
			opacity: 1;
		}
		to {
			width: 100%;
			opacity: 0;
		}
	}
</style>
