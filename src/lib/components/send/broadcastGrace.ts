// R3 (docs/UX-PSYCHOLOGY-RESEARCH-2026-07-15.md, cairn-avzs): the "Sending in
// 5s — Cancel" broadcast grace window. Manifesto's confirmation-friction
// ladder says "undo beats a warning dialog," but broadcast is irreversible so
// today all safety lives pre-commit. This manufactures a brief, genuine undo
// window at the exact post-commit moment wrong-paste slips actually surface
// (F5) — the strongest error-recovery pattern available for an action that
// can't be undone once the network has it.
//
// Plain TS, no Svelte runes — deliberately, so it's testable with
// vi.useFakeTimers() without a Svelte-aware vitest transform (this repo's
// vitest.config.ts has no svelte plugin; see toast.svelte.ts for the sibling
// pattern that DOES use runes and is, not coincidentally, never unit-tested
// directly). A thin Svelte wrapper (BroadcastGraceControl.svelte) mirrors
// this engine's state into its own $state via the onChange callback.
//
// State machine: idle -[start]-> counting -[skip | timer elapses]-> firing
//                          counting -[cancel]-> idle
//                          counting -[destroy]-> idle (no fire)
//
// `destroy()` is the load-bearing safety property: a Svelte component's
// $effect cleanup calls it on unmount, so navigating away or closing the tab
// during the window can never let a stray setTimeout reach the network after
// the fact. Combined with `fired` latching in `fire()`, onFire is guaranteed
// to run at most once, and never after cancel/destroy.

export type GraceStatus = 'idle' | 'counting' | 'firing';

export const GRACE_DURATION_MS = 5000;

/** How often `remainingMs`/`secondsLeft` are refreshed while counting — only
 *  cosmetic (drives the plain-digit countdown under reduced motion); the
 *  actual fire is a single `setTimeout` for the full duration, not derived
 *  from these ticks. */
const TICK_MS = 250;

export interface GraceClock {
	now: () => number;
	setTimeout: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>;
	clearTimeout: (id: ReturnType<typeof setTimeout>) => void;
	setInterval: (cb: () => void, ms: number) => ReturnType<typeof setInterval>;
	clearInterval: (id: ReturnType<typeof setInterval>) => void;
}

const REAL_CLOCK: GraceClock = {
	now: () => Date.now(),
	setTimeout: (cb, ms) => setTimeout(cb, ms),
	clearTimeout: (id) => clearTimeout(id),
	setInterval: (cb, ms) => setInterval(cb, ms),
	clearInterval: (id) => clearInterval(id)
};

export interface BroadcastGraceOptions {
	/** Called exactly once — when the window elapses naturally or is skipped.
	 *  Never called after cancel() or destroy(). */
	onFire: () => void;
	/** Called after every state change so a UI layer (or a test) can observe
	 *  it without polling. */
	onChange?: () => void;
	durationMs?: number;
	/** Injectable for tests (vi.useFakeTimers() also works without this —
	 *  either style is supported). */
	clock?: GraceClock;
}

export class BroadcastGrace {
	readonly durationMs: number;

	status: GraceStatus = 'idle';
	remainingMs: number;

	private readonly clock: GraceClock;
	private readonly onFireCb: () => void;
	private readonly onChangeCb: () => void;
	private timerId: ReturnType<typeof setTimeout> | null = null;
	private tickId: ReturnType<typeof setInterval> | null = null;
	private startedAt = 0;
	private fired = false;

	constructor(opts: BroadcastGraceOptions) {
		this.durationMs = opts.durationMs ?? GRACE_DURATION_MS;
		this.onFireCb = opts.onFire;
		this.onChangeCb = opts.onChange ?? (() => {});
		this.clock = opts.clock ?? REAL_CLOCK;
		this.remainingMs = this.durationMs;
	}

	/** Whole seconds remaining, for the "Sending in Ns" copy — always >= 0,
	 *  and rounds UP so the label reads "5s" for the entire first second
	 *  rather than flashing to "4s" immediately. */
	get secondsLeft(): number {
		return Math.max(0, Math.ceil(this.remainingMs / 1000));
	}

	/** 0 at arm, 1 at fire — the unwinding ring reads this only indirectly
	 *  (it's CSS-animation-driven for smoothness), but tests and the
	 *  reduced-motion fallback use it directly. */
	get progress(): number {
		if (this.durationMs <= 0) return 1;
		return 1 - this.remainingMs / this.durationMs;
	}

	/** Arm the window. No-op if already counting (a double-click on the
	 *  primary button must not restart the clock). */
	start(): void {
		if (this.status === 'counting') return;
		this.fired = false;
		this.status = 'counting';
		this.startedAt = this.clock.now();
		this.remainingMs = this.durationMs;
		this.timerId = this.clock.setTimeout(() => this.fire(), this.durationMs);
		this.tickId = this.clock.setInterval(() => this.tick(), TICK_MS);
		this.onChangeCb();
	}

	private tick(): void {
		if (this.status !== 'counting') return;
		const elapsed = this.clock.now() - this.startedAt;
		this.remainingMs = Math.max(0, this.durationMs - elapsed);
		this.onChangeCb();
	}

	/** User-initiated cancel: stop the window and go back to idle so the
	 *  primary button works again. Touches nothing about the underlying
	 *  transaction/review state — the caller's draft, signatures, and step
	 *  are all untouched, so "cancel" is genuinely free (no wizard wipe). */
	cancel(): void {
		if (this.status !== 'counting') return;
		this.clearTimers();
		this.status = 'idle';
		this.remainingMs = this.durationMs;
		this.onChangeCb();
	}

	/** User-initiated skip ("Send now"): fire immediately instead of waiting
	 *  out the rest of the window. */
	skip(): void {
		if (this.status !== 'counting') return;
		this.clearTimers();
		this.fire();
	}

	/** Tear down without ever firing. Call from a Svelte $effect's cleanup
	 *  (unmount) — covers in-app navigation away from the Confirm step while
	 *  the window is counting. A hard reload / tab close needs no equivalent
	 *  call: JS execution simply stops, so the pending setTimeout can never
	 *  run either way. Either path satisfies R3's "navigate-away == cancel"
	 *  rule; this method exists for the SPA-navigation case specifically. */
	destroy(): void {
		const wasCounting = this.status === 'counting';
		this.clearTimers();
		if (wasCounting) {
			this.status = 'idle';
			this.remainingMs = this.durationMs;
			this.onChangeCb();
		}
	}

	private fire(): void {
		if (this.fired) return;
		this.fired = true;
		this.clearTimers();
		this.status = 'firing';
		this.remainingMs = 0;
		this.onChangeCb();
		this.onFireCb();
	}

	private clearTimers(): void {
		if (this.timerId !== null) {
			this.clock.clearTimeout(this.timerId);
			this.timerId = null;
		}
		if (this.tickId !== null) {
			this.clock.clearInterval(this.tickId);
			this.tickId = null;
		}
	}
}
