<script lang="ts">
	/**
	 * FirstSyncGrowth — the first-sync wood-growth canvas (design 1a,
	 * cairn-koy4.11). The trunk grows outward from the pith as the chain's
	 * history is counted: one growth ring per difficulty epoch, halving
	 * epochs land cream, a bright scanning frontier rides the young edge,
	 * and each newly completed ring flashes as it hardens. In the synced
	 * state the frontier settles, the currently forming ring draws as a
	 * partial arc with a pulsing tip, and a single cream sweep runs
	 * pith → bark (the hwSweepOnce moment, in canvas).
	 *
	 * Port of the `setSync` canvas in `Heartwood App - Signature.dc.html`,
	 * with two honest deviations from the prototype:
	 *   - Progress is driven by real epoch counts from /api/sync, eased
	 *     locally — never a scripted timeline.
	 *   - Ring spacing is uniform and per-ring alpha is a seeded texture:
	 *     real epoch durations aren't known until the count finishes (they
	 *     are what's being fetched), so duration-scaled spacing would be a
	 *     fabrication mid-sync. Ring COUNT and position of the frontier are
	 *     the real data.
	 *
	 * The breathing aura (hwBreathe, first-sync only per the motion spec)
	 * is part of this component so every consumer gets the same halo.
	 */
	let {
		epochsKnown = 0,
		epochsTotal = 0,
		synced = false,
		formingProgress = 0
	}: {
		epochsKnown?: number;
		epochsTotal?: number;
		synced?: boolean;
		formingProgress?: number;
	} = $props();

	const TAU = Math.PI * 2;
	/** Vertical squish — the trunk isn't a perfect circle. */
	const SQUISH = 0.97;
	const HALVING_INTERVAL = 210_000;
	const EPOCH = 2016;

	let canvas: HTMLCanvasElement;
	let holder: HTMLDivElement;

	// --------------------------------------------------------- deterministic texture
	function mulberry32(seed: number): () => number {
		return () => {
			seed |= 0;
			seed = (seed + 0x6d2b79f5) | 0;
			let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
			t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
			return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
		};
	}

	let alphaSeeds: number[] = [];
	function ensureTexture(total: number): void {
		if (alphaSeeds.length === total) return;
		const rnd = mulberry32(777);
		alphaSeeds = Array.from({ length: total }, () => rnd());
	}

	/** Ring i closes epoch i−1 — cream when that epoch contains a halving. */
	function isHalvingRing(i: number): boolean {
		const lo = (i - 1) * EPOCH;
		const hi = lo + EPOCH;
		const k = Math.floor((hi - 1) / HALVING_INTERVAL);
		return k > 0 && k * HALVING_INTERVAL >= lo;
	}

	// -------------------------------------------------------------------- geometry
	interface Geom {
		dpr: number;
		W: number;
		H: number;
		cx: number;
		cy: number;
		R: number;
		coreR: number;
	}
	let g: Geom | null = null;

	function ensureCanvas(): boolean {
		const rect = holder.getBoundingClientRect();
		if (rect.width < 2) return false;
		const dpr = Math.min(2, window.devicePixelRatio || 1);
		const W = Math.round(rect.width * dpr);
		const H = Math.round(rect.height * dpr);
		if (canvas.width !== W || canvas.height !== H || !g || g.dpr !== dpr) {
			canvas.width = W;
			canvas.height = H;
			const R = Math.min(W, H) / 2 - 14 * dpr;
			g = { dpr, W, H, cx: W / 2, cy: H / 2, R, coreR: R * 0.05 };
			ringLayer = null; // resolution changed — rebuild the cached rings
		}
		return true;
	}

	function wob(th: number, B: number): number {
		const R = g!.R;
		const t = B / R;
		return (
			t *
			(0.018 * R * Math.cos(th) +
				0.05 * R * Math.sin(th) +
				0.013 * R * Math.sin(2 * th + 1.2 + t * 1.6) +
				0.006 * R * Math.sin(3 * th - 0.5 - t * 2.2))
		);
	}

	function ringPath(ctx: CanvasRenderingContext2D, B: number, segs = 88): void {
		ctx.beginPath();
		for (let s = 0; s <= segs; s++) {
			const th = (s / segs) * TAU;
			const r = B + wob(th, B);
			const x = g!.cx + Math.cos(th) * r;
			const y = g!.cy + Math.sin(th) * r * SQUISH;
			if (s === 0) ctx.moveTo(x, y);
			else ctx.lineTo(x, y);
		}
		ctx.closePath();
	}

	/** Radius of ring boundary i with uniform per-epoch spacing. */
	function ringR(i: number, total: number): number {
		return g!.coreR + (g!.R - g!.coreR) * (i / Math.max(1, total));
	}

	// ------------------------------------------------------- cached completed rings
	// Redrawing ~475 wobbled polylines every frame is what the prototype does;
	// caching them to an offscreen layer keeps the rAF budget for the live parts.
	let ringLayer: HTMLCanvasElement | null = null;
	let ringLayerCount = -1;

	function buildRingLayer(nDone: number, total: number): void {
		if (ringLayer && ringLayerCount === nDone) return;
		if (!ringLayer) {
			ringLayer = document.createElement('canvas');
		}
		ringLayer.width = g!.W;
		ringLayer.height = g!.H;
		ringLayerCount = nDone;
		const ctx = ringLayer.getContext('2d')!;
		const dpr = g!.dpr;
		ensureTexture(total);
		for (let i = 1; i <= nDone; i++) {
			const bn = alphaSeeds[i - 1] ?? 0.5;
			const pop = bn > 0.87;
			if (isHalvingRing(i)) {
				ctx.strokeStyle = 'rgba(251,225,198,.8)';
				ctx.lineWidth = 1.4 * dpr;
				ctx.shadowColor = 'rgba(232,147,90,.6)';
				ctx.shadowBlur = 5 * dpr;
			} else {
				ctx.strokeStyle = `rgba(232,147,90,${(0.07 + 0.14 * bn + (pop ? 0.28 : 0)).toFixed(3)})`;
				ctx.lineWidth = (0.55 + 0.55 * bn + (pop ? 0.35 : 0)) * dpr;
			}
			ringPath(ctx, ringR(i, total), i > total * 0.6 ? 96 : 72);
			ctx.stroke();
			ctx.shadowBlur = 0;
		}
	}

	// ------------------------------------------------------------------ animation
	let p = 0; // eased progress 0..1
	let lastNow = 0;
	let raf = 0;
	let flash: { i: number; t: number } | null = null;
	let lastRingCount = -1;
	let syncedAt: number | null = null;
	let wasSynced = false;
	let reducedMotion = false;

	function targetP(): number {
		if (synced) return 1;
		return epochsTotal > 0 ? Math.min(1, epochsKnown / epochsTotal) : 0;
	}

	function frame(now: number): void {
		raf = requestAnimationFrame(frame);
		if (!ensureCanvas()) return;
		const dt = lastNow ? Math.min(0.1, (now - lastNow) / 1000) : 0.016;
		lastNow = now;

		// Ease toward the real progress; a poll-step never snaps the wood.
		const t = targetP();
		p += (t - p) * Math.min(1, dt * 2.2);
		if (Math.abs(t - p) < 0.0005) p = t;

		if (synced && !wasSynced) syncedAt = now;
		wasSynced = synced;

		draw(now);
	}

	function draw(now: number): void {
		const ctx = canvas.getContext('2d')!;
		const { dpr, cx, cy, coreR } = g!;
		const time = now / 1000;
		const total = Math.max(1, epochsTotal || 475);
		ctx.clearRect(0, 0, g!.W, g!.H);

		const rNow = Math.max(coreR * 1.6, coreR + (g!.R - coreR) * p);
		const done = synced && p >= 0.999;

		// Wood disc.
		const wg = ctx.createRadialGradient(cx, cy, 0, cx, cy, rNow * 1.05);
		wg.addColorStop(0, '#3b2b1f');
		wg.addColorStop(0.55, '#281b12');
		wg.addColorStop(1, '#170f0a');
		ringPath(ctx, rNow);
		ctx.fillStyle = wg;
		ctx.fill();

		// Completed rings (cached layer).
		const nDone = Math.min(total, Math.floor(p * total));
		buildRingLayer(nDone, total);
		if (ringLayer) ctx.drawImage(ringLayer, 0, 0);

		// A ring hardens: cream flash on completion.
		if (lastRingCount === -1) lastRingCount = nDone;
		if (nDone > lastRingCount) {
			flash = { i: nDone, t: now };
			lastRingCount = nDone;
		}
		if (nDone < lastRingCount) lastRingCount = nDone;
		if (flash && now - flash.t < 700 && flash.i <= nDone) {
			const k = 1 - (now - flash.t) / 700;
			ctx.strokeStyle = `rgba(251,225,198,${(0.7 * k).toFixed(3)})`;
			ctx.lineWidth = 1.6 * dpr;
			ctx.shadowColor = 'rgba(232,147,90,.8)';
			ctx.shadowBlur = 8 * dpr;
			ringPath(ctx, ringR(flash.i, total), 96);
			ctx.stroke();
			ctx.shadowBlur = 0;
		}

		// Frontier — the bark being written.
		ctx.lineWidth = 1.8 * dpr;
		ctx.strokeStyle = done ? 'rgba(232,147,90,.9)' : 'rgba(246,200,154,.85)';
		ctx.shadowColor = 'rgba(232,147,90,.6)';
		ctx.shadowBlur = 7 * dpr;
		ringPath(ctx, rNow, 96);
		ctx.stroke();
		ctx.shadowBlur = 0;

		if (!done) {
			// Scanning arc sweeping the frontier.
			const a0 = reducedMotion ? -Math.PI / 2 : (time * 1.4) % TAU;
			const seg = 0.8;
			ctx.beginPath();
			for (let s = 0; s <= 22; s++) {
				const th = a0 + (seg * s) / 22;
				const r = rNow + wob(th, rNow);
				const x = cx + Math.cos(th) * r;
				const y = cy + Math.sin(th) * r * SQUISH;
				if (s === 0) ctx.moveTo(x, y);
				else ctx.lineTo(x, y);
			}
			ctx.strokeStyle = 'rgba(255,238,216,.9)';
			ctx.lineWidth = 2.4 * dpr;
			ctx.shadowColor = 'rgba(232,147,90,.9)';
			ctx.shadowBlur = 10 * dpr;
			ctx.lineCap = 'round';
			ctx.stroke();
			ctx.shadowBlur = 0;
		} else {
			// The forming ring grows just outside the bark, tip pulsing.
			const prog = Math.min(Math.max(formingProgress, 0), 1);
			const th0 = -Math.PI / 2;
			const th1 = th0 + prog * TAU;
			const rF = rNow + 5 * dpr;
			ctx.beginPath();
			for (let s = 0; s <= 40; s++) {
				const th = th0 + ((th1 - th0) * s) / 40;
				const r = rF + wob(th, rF);
				const x = cx + Math.cos(th) * r;
				const y = cy + Math.sin(th) * r * SQUISH;
				if (s === 0) ctx.moveTo(x, y);
				else ctx.lineTo(x, y);
			}
			ctx.strokeStyle = 'rgba(246,200,154,.8)';
			ctx.lineWidth = 1.5 * dpr;
			ctx.shadowColor = 'rgba(232,147,90,.7)';
			ctx.shadowBlur = 6 * dpr;
			ctx.stroke();
			ctx.shadowBlur = 0;

			const rT = rF + wob(th1, rF);
			const tx = cx + Math.cos(th1) * rT;
			const ty = cy + Math.sin(th1) * rT * SQUISH;
			const pulse = reducedMotion ? 0.5 : 0.5 + 0.5 * Math.sin(time * 2.2);
			ctx.beginPath();
			ctx.arc(tx, ty, (2.4 + 0.8 * pulse) * dpr, 0, TAU);
			ctx.fillStyle = '#fbe1c6';
			ctx.shadowColor = 'rgba(232,147,90,1)';
			ctx.shadowBlur = 9 * dpr;
			ctx.fill();
			ctx.shadowBlur = 0;

			// One sweep as the count closes — hwSweepOnce, drawn in canvas.
			if (!reducedMotion && syncedAt !== null && now - syncedAt < 4200) {
				const sp = (now - syncedAt) / 4200;
				const ease = 1 - Math.pow(1 - sp, 3);
				ctx.strokeStyle = `rgba(251,225,198,${(0.55 * (1 - sp)).toFixed(3)})`;
				ctx.lineWidth = 1.6 * dpr;
				ringPath(ctx, coreR + (rNow - coreR) * ease, 96);
				ctx.stroke();
			}
		}

		// The pith.
		const cp = reducedMotion ? 0.9 : 0.82 + 0.18 * Math.sin(time * 1.6);
		const cg = ctx.createRadialGradient(cx, cy, 0, cx, cy, coreR * 3);
		cg.addColorStop(0, `rgba(255,238,216,${(0.85 * cp).toFixed(3)})`);
		cg.addColorStop(0.35, `rgba(246,200,154,${(0.4 * cp).toFixed(3)})`);
		cg.addColorStop(1, 'rgba(232,147,90,0)');
		ctx.fillStyle = cg;
		ctx.beginPath();
		ctx.arc(cx, cy, coreR * 3, 0, TAU);
		ctx.fill();
		ctx.fillStyle = `rgba(255,245,232,${cp.toFixed(3)})`;
		ctx.beginPath();
		ctx.arc(cx, cy, 2.4 * dpr, 0, TAU);
		ctx.fill();
	}

	$effect(() => {
		reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
		if (reducedMotion) {
			// Static render: draw the real progress once, re-draw on data change
			// (the effect below), no continuous loop.
			p = targetP();
			if (ensureCanvas()) draw(performance.now());
			const onResize = () => {
				if (ensureCanvas()) draw(performance.now());
			};
			window.addEventListener('resize', onResize);
			return () => window.removeEventListener('resize', onResize);
		}
		raf = requestAnimationFrame(frame);
		const onResize = () => ensureCanvas();
		window.addEventListener('resize', onResize);
		return () => {
			cancelAnimationFrame(raf);
			window.removeEventListener('resize', onResize);
		};
	});

	// Reduced motion: any data step re-renders one fresh static frame.
	$effect(() => {
		void epochsKnown;
		void epochsTotal;
		void synced;
		void formingProgress;
		if (reducedMotion && canvas && ensureCanvas()) {
			p = targetP();
			ringLayer = null;
			draw(performance.now());
		}
	});
</script>

<div class="growth" bind:this={holder} aria-hidden="true">
	<div class="aura"></div>
	<canvas bind:this={canvas}></canvas>
</div>

<style>
	.growth {
		position: relative;
		width: 100%;
		height: 100%;
	}

	/* First-sync aura — the only sanctioned use of hwBreathe (motion spec). */
	.aura {
		position: absolute;
		inset: -60px;
		background: radial-gradient(
			circle,
			rgba(232, 147, 90, 0.09),
			rgba(232, 147, 90, 0.02) 50%,
			transparent 70%
		);
		animation: hwBreathe 9s ease-in-out infinite;
		pointer-events: none;
	}

	canvas {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		display: block;
	}
</style>
