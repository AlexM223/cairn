// R3 (cairn-avzs) — the broadcast grace window's state machine. Fake timers
// throughout: these tests pin the exact contract the Confirm step's
// BroadcastGraceControl.svelte relies on — most importantly that onFire can
// NEVER run after cancel() or destroy(), which is the property that makes
// "navigate away during the window" safe to treat as a cancel.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BroadcastGrace, GRACE_DURATION_MS } from './broadcastGrace';

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

describe('BroadcastGrace — idle/counting/firing', () => {
	it('starts idle and only fires once the full duration elapses', () => {
		const onFire = vi.fn();
		const grace = new BroadcastGrace({ onFire });
		expect(grace.status).toBe('idle');

		grace.start();
		expect(grace.status).toBe('counting');
		expect(onFire).not.toHaveBeenCalled();

		vi.advanceTimersByTime(GRACE_DURATION_MS - 1);
		expect(onFire).not.toHaveBeenCalled();
		expect(grace.status).toBe('counting');

		vi.advanceTimersByTime(1);
		expect(onFire).toHaveBeenCalledTimes(1);
		expect(grace.status).toBe('firing');
	});

	it('defaults to a 5-second window', () => {
		expect(GRACE_DURATION_MS).toBe(5000);
	});

	it('respects a custom duration', () => {
		const onFire = vi.fn();
		const grace = new BroadcastGrace({ onFire, durationMs: 2000 });
		grace.start();
		vi.advanceTimersByTime(1999);
		expect(onFire).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(onFire).toHaveBeenCalledTimes(1);
	});

	it('double-starting does not restart the clock', () => {
		const onFire = vi.fn();
		const grace = new BroadcastGrace({ onFire });
		grace.start();
		vi.advanceTimersByTime(3000);
		grace.start(); // no-op — already counting
		vi.advanceTimersByTime(2000); // total 5000ms from the FIRST start
		expect(onFire).toHaveBeenCalledTimes(1);
	});

	it('re-arms cleanly after firing (a fresh send after Sent)', () => {
		const onFire = vi.fn();
		const grace = new BroadcastGrace({ onFire });
		grace.start();
		vi.advanceTimersByTime(GRACE_DURATION_MS);
		expect(grace.status).toBe('firing');

		grace.start();
		expect(grace.status).toBe('counting');
		vi.advanceTimersByTime(GRACE_DURATION_MS);
		expect(onFire).toHaveBeenCalledTimes(2);
	});
});

describe('BroadcastGrace — cancel', () => {
	it('cancel during the window stops the timer and never fires', () => {
		const onFire = vi.fn();
		const grace = new BroadcastGrace({ onFire });
		grace.start();
		vi.advanceTimersByTime(2000);
		grace.cancel();
		expect(grace.status).toBe('idle');

		// Advance well past the original deadline — onFire must never run.
		vi.advanceTimersByTime(10_000);
		expect(onFire).not.toHaveBeenCalled();
	});

	it('cancel resets remainingMs so a re-arm gets the full window', () => {
		const grace = new BroadcastGrace({ onFire: vi.fn() });
		grace.start();
		vi.advanceTimersByTime(4000);
		expect(grace.remainingMs).toBeLessThanOrEqual(1000);
		grace.cancel();
		expect(grace.remainingMs).toBe(GRACE_DURATION_MS);
	});

	it('cancel is a no-op when idle or already firing', () => {
		const onFire = vi.fn();
		const grace = new BroadcastGrace({ onFire });
		grace.cancel(); // idle — no-op
		expect(grace.status).toBe('idle');

		grace.start();
		vi.advanceTimersByTime(GRACE_DURATION_MS);
		expect(grace.status).toBe('firing');
		grace.cancel(); // firing — no-op, must not un-fire
		expect(grace.status).toBe('firing');
	});
});

describe('BroadcastGrace — skip ("Send now")', () => {
	it('skip fires immediately without waiting out the window', () => {
		const onFire = vi.fn();
		const grace = new BroadcastGrace({ onFire });
		grace.start();
		vi.advanceTimersByTime(500);
		grace.skip();
		expect(onFire).toHaveBeenCalledTimes(1);
		expect(grace.status).toBe('firing');
	});

	it('skip when idle does nothing', () => {
		const onFire = vi.fn();
		const grace = new BroadcastGrace({ onFire });
		grace.skip();
		expect(onFire).not.toHaveBeenCalled();
		expect(grace.status).toBe('idle');
	});

	it('a stale timer cannot double-fire after skip', () => {
		const onFire = vi.fn();
		const grace = new BroadcastGrace({ onFire });
		grace.start();
		grace.skip();
		// Even though the original setTimeout would have landed here, skip()
		// already cleared it — advancing time must not produce a second call.
		vi.advanceTimersByTime(GRACE_DURATION_MS * 2);
		expect(onFire).toHaveBeenCalledTimes(1);
	});
});

describe('BroadcastGrace — destroy (navigate-away / unmount)', () => {
	it('destroy during the window tears down the timer and never fires — the core R3 safety property', () => {
		const onFire = vi.fn();
		const grace = new BroadcastGrace({ onFire });
		grace.start();
		vi.advanceTimersByTime(4500); // 500ms from firing
		grace.destroy();

		vi.advanceTimersByTime(60_000);
		expect(onFire).not.toHaveBeenCalled();
	});

	it('destroy leaves status idle so a remount reads a clean slate', () => {
		const grace = new BroadcastGrace({ onFire: vi.fn() });
		grace.start();
		vi.advanceTimersByTime(1000);
		grace.destroy();
		expect(grace.status).toBe('idle');
	});

	it('destroy when idle is a harmless no-op', () => {
		const onChange = vi.fn();
		const grace = new BroadcastGrace({ onFire: vi.fn(), onChange });
		grace.destroy();
		expect(grace.status).toBe('idle');
		expect(onChange).not.toHaveBeenCalled();
	});

	it('destroy after firing does not un-fire or throw', () => {
		const onFire = vi.fn();
		const grace = new BroadcastGrace({ onFire });
		grace.start();
		vi.advanceTimersByTime(GRACE_DURATION_MS);
		expect(onFire).toHaveBeenCalledTimes(1);
		expect(() => grace.destroy()).not.toThrow();
		expect(grace.status).toBe('firing');
	});
});

describe('BroadcastGrace — remainingMs / secondsLeft / progress', () => {
	it('secondsLeft rounds up and starts at the full duration', () => {
		const grace = new BroadcastGrace({ onFire: vi.fn() });
		grace.start();
		expect(grace.secondsLeft).toBe(5);
		vi.advanceTimersByTime(4001); // 999ms left
		expect(grace.secondsLeft).toBe(1);
		vi.advanceTimersByTime(999);
		expect(grace.secondsLeft).toBe(0);
	});

	it('progress goes from 0 at arm to 1 at fire', () => {
		const grace = new BroadcastGrace({ onFire: vi.fn() });
		grace.start();
		expect(grace.progress).toBe(0);
		vi.advanceTimersByTime(2500);
		expect(grace.progress).toBeCloseTo(0.5, 1);
		vi.advanceTimersByTime(2500);
		expect(grace.progress).toBe(1);
	});

	it('calls onChange on start, on each tick, and on fire', () => {
		const onChange = vi.fn();
		const grace = new BroadcastGrace({ onFire: vi.fn(), onChange, durationMs: 1000 });
		grace.start();
		expect(onChange).toHaveBeenCalledTimes(1); // start
		vi.advanceTimersByTime(1000);
		expect(onChange.mock.calls.length).toBeGreaterThan(2); // ticks + fire
		expect(grace.status).toBe('firing');
	});
});

describe('BroadcastGrace — onFire is called at most once (no double-broadcast)', () => {
	it('never fires twice even across start/cancel/re-start/skip sequences', () => {
		const onFire = vi.fn();
		const grace = new BroadcastGrace({ onFire });
		grace.start();
		vi.advanceTimersByTime(1000);
		grace.cancel();
		grace.start();
		vi.advanceTimersByTime(1000);
		grace.skip();
		expect(onFire).toHaveBeenCalledTimes(1);
		vi.advanceTimersByTime(10_000);
		expect(onFire).toHaveBeenCalledTimes(1);
	});
});
