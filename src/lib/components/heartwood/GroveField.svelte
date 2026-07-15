<script lang="ts">
	/**
	 * GroveField — the Heartwood background atmosphere layer.
	 *
	 * The viewer stands inside the trunk: growth rings sweep in as enormous
	 * faint arcs from an off-screen pith (top-left), with a few glowing dust
	 * motes between them. Pure background — "felt, never read".
	 *
	 * USAGE CONTRACT (the parent page's job, not enforceable from here):
	 *   - the parent container must be `position: relative`
	 *   - the page content must sit at `z-index: 1` or higher
	 *   - render this component as the first child:
	 *       <div class="page" style="position: relative">
	 *           <GroveField volume="present" />
	 *           <div style="position: relative; z-index: 1">…content…</div>
	 *       </div>
	 *
	 * Volumes (per spec table): whisper (Activity/Node/Settings),
	 * present (Home/Send/Sign/Receive/Wallet/Explorer),
	 * grove (Login/Sent/First-sync — adds the cool evergreen wash).
	 *
	 * Geometry lives entirely in CSS custom properties so the mobile variant
	 * is a media-query override of the same gradient stack, cheap to tune.
	 */
	let { volume = 'present' }: { volume?: 'whisper' | 'present' | 'grove' } = $props();
</script>

<div class="grove-field {volume}" aria-hidden="true">
	<!-- Dust motes: tiny glow dots pulsing slowly. Element opacity is what
	     hwPulse animates; the mote's peak brightness is the alpha baked into
	     its gradient (per-volume via --ma*). Reduced motion is handled by the
	     global app.css block that zeroes all animation durations. -->
	<span class="mote m1"></span>
	<span class="mote m2"></span>
	<span class="mote m3"></span>
	<span class="mote m4"></span>
</div>

<style>
	.grove-field {
		position: absolute;
		inset: 0;
		z-index: 0;
		pointer-events: none;
		overflow: hidden;

		/* Desktop pith + ring radii (spec: pith -380,-320; ~8 rings 700→2060). */
		--gp-x: -380px;
		--gp-y: -320px;
		--gr1: 700px;
		--gr2: 890px;
		--gr3: 1080px;
		--gr4: 1275px;
		--gr5: 1470px;
		--gr6: 1665px;
		--gr7: 1860px;
		--gr8: 2060px;

		/* Present volume is the default (ring α .045–.065, cream .08). */
		--ga1: 0.062;
		--ga2: 0.048;
		--ga3: 0.057;
		--ga4: 0.08; /* cream */
		--ga5: 0.046;
		--ga6: 0.061;
		--ga7: 0.052;
		--ga8: 0.08; /* cream */
		--gwa1: 0;
		--gwa2: 0;
		--ma1: 0.3;
		--ma2: 0.22;
		--ma3: 0.27;
		--ma4: 0.18;

		/* One ring per layer: transparent N-1px → slate-blue Npx → transparent
		   N+3px. Rings 4 and 8 (every 4th–5th) are brighter cream epoch rings
		   #D4E5F4. The cool evergreen wash sits at the bottom of the stack
		   (grove volume only — its alphas are 0 elsewhere). */
		background:
			radial-gradient(
				circle at var(--gp-x) var(--gp-y),
				transparent calc(var(--gr1) - 1px),
				rgba(103, 150, 201, var(--ga1)) var(--gr1),
				transparent calc(var(--gr1) + 3px)
			),
			radial-gradient(
				circle at var(--gp-x) var(--gp-y),
				transparent calc(var(--gr2) - 1px),
				rgba(103, 150, 201, var(--ga2)) var(--gr2),
				transparent calc(var(--gr2) + 3px)
			),
			radial-gradient(
				circle at var(--gp-x) var(--gp-y),
				transparent calc(var(--gr3) - 1px),
				rgba(103, 150, 201, var(--ga3)) var(--gr3),
				transparent calc(var(--gr3) + 3px)
			),
			radial-gradient(
				circle at var(--gp-x) var(--gp-y),
				transparent calc(var(--gr4) - 1px),
				rgba(212, 229, 244, var(--ga4)) var(--gr4),
				transparent calc(var(--gr4) + 3px)
			),
			radial-gradient(
				circle at var(--gp-x) var(--gp-y),
				transparent calc(var(--gr5) - 1px),
				rgba(103, 150, 201, var(--ga5)) var(--gr5),
				transparent calc(var(--gr5) + 3px)
			),
			radial-gradient(
				circle at var(--gp-x) var(--gp-y),
				transparent calc(var(--gr6) - 1px),
				rgba(103, 150, 201, var(--ga6)) var(--gr6),
				transparent calc(var(--gr6) + 3px)
			),
			radial-gradient(
				circle at var(--gp-x) var(--gp-y),
				transparent calc(var(--gr7) - 1px),
				rgba(103, 150, 201, var(--ga7)) var(--gr7),
				transparent calc(var(--gr7) + 3px)
			),
			radial-gradient(
				circle at var(--gp-x) var(--gp-y),
				transparent calc(var(--gr8) - 1px),
				rgba(212, 229, 244, var(--ga8)) var(--gr8),
				transparent calc(var(--gr8) + 3px)
			),
			radial-gradient(
				circle at -18% -28%,
				rgba(28, 37, 35, var(--gwa1)),
				rgba(20, 27, 25, var(--gwa2)) 46%,
				transparent 74%
			);
		background-repeat: no-repeat;
	}

	.grove-field.whisper {
		--ga1: 0.036;
		--ga2: 0.032;
		--ga3: 0.035;
		--ga4: 0.05;
		--ga5: 0.033;
		--ga6: 0.038;
		--ga7: 0.034;
		--ga8: 0.05;
		/* Whisper: 2 barely-there motes, others off. */
		--ma1: 0.16;
		--ma2: 0.12;
		--ma3: 0;
		--ma4: 0;
	}

	.grove-field.grove {
		--ga1: 0.092;
		--ga2: 0.072;
		--ga3: 0.085;
		--ga4: 0.13;
		--ga5: 0.07;
		--ga6: 0.098;
		--ga7: 0.078;
		--ga8: 0.13;
		/* Cool evergreen wash under everything. */
		--gwa1: 0.45;
		--gwa2: 0.2;
		--ma1: 0.4;
		--ma2: 0.28;
		--ma3: 0.34;
		--ma4: 0.22;
	}

	/* Mobile geometry: same stack, tighter pith and radii (spec: pith
	   -160,-140; ~5 rings 260→690). Rings 6–8 are pushed far enough out that
	   they fall off-screen on phone viewports — cheaper than a second stack. */
	@media (max-width: 900px) {
		.grove-field {
			--gp-x: -160px;
			--gp-y: -140px;
			--gr1: 260px;
			--gr2: 368px;
			--gr3: 475px;
			--gr4: 582px; /* cream — 4th of the 5 visible rings */
			--gr5: 690px;
			--gr6: 1500px;
			--gr7: 1850px;
			--gr8: 2200px;
		}
	}

	.mote {
		position: absolute;
		width: 5px;
		height: 5px;
		border-radius: 50%;
		/* ~2.2px glowing core with soft falloff; peak alpha per volume. */
		background: radial-gradient(
			circle,
			rgba(182, 210, 234, var(--ma, 0.2)) 0%,
			rgba(182, 210, 234, calc(var(--ma, 0.2) * 0.5)) 42%,
			transparent 72%
		);
		animation: hwPulse 4.4s ease-in-out infinite;
	}

	.m1 {
		--ma: var(--ma1);
		left: 66%;
		top: 24%;
	}

	.m2 {
		--ma: var(--ma2);
		left: 30%;
		top: 56%;
		animation-duration: 5.6s;
		animation-delay: 0.8s;
	}

	.m3 {
		--ma: var(--ma3);
		left: 82%;
		top: 66%;
		animation-duration: 6s;
		animation-delay: 1.6s;
	}

	.m4 {
		--ma: var(--ma4);
		left: 18%;
		top: 34%;
		animation-duration: 5s;
		animation-delay: 2.6s;
	}
</style>
