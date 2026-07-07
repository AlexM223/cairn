// Central toast store (cairn-ivae.5) — the one place transient user feedback
// lives. Pages render the queue by mounting <Toasts /> (once, anywhere in the
// page) and fire messages imperatively:
//
//   import { toast } from '$lib/components/toast.svelte';
//   toast.success('Profile updated.');
//   toast.error('Could not reach Cairn to save the address.');
//   toast.info('Copied to clipboard.', { duration: 2500 });
//
// Timing is consistent app-wide: successes/info auto-dismiss quickly, errors
// linger longer (and can be made sticky with duration: 0 — dismissed only by
// the user). For persistent conditions or errors that need inline recovery
// actions next to the thing that failed, use <Banner> in place instead —
// toasts are for transient action feedback.

export type ToastVariant = 'success' | 'error' | 'info' | 'warning';

export interface ToastItem {
	id: number;
	variant: ToastVariant;
	message: string;
	/** ms before auto-dismiss; 0 = sticky until manually dismissed. */
	duration: number;
}

export interface ToastOptions {
	/** Override the variant's default auto-dismiss delay (ms). 0 = sticky. */
	duration?: number;
}

const DEFAULT_DURATION_MS: Record<ToastVariant, number> = {
	success: 4_000,
	info: 5_000,
	warning: 7_000,
	error: 8_000
};

const items = $state<ToastItem[]>([]);
const timers = new Map<number, ReturnType<typeof setTimeout>>();
let nextId = 1;

function dismiss(id: number): void {
	const timer = timers.get(id);
	if (timer) {
		clearTimeout(timer);
		timers.delete(id);
	}
	const idx = items.findIndex((t) => t.id === id);
	if (idx >= 0) items.splice(idx, 1);
}

function push(variant: ToastVariant, message: string, opts?: ToastOptions): number {
	const id = nextId++;
	const duration = opts?.duration ?? DEFAULT_DURATION_MS[variant];
	items.push({ id, variant, message, duration });
	if (duration > 0) {
		timers.set(
			id,
			setTimeout(() => dismiss(id), duration)
		);
	}
	return id;
}

export const toast = {
	/** The live queue — rendered by <Toasts />. */
	get items(): readonly ToastItem[] {
		return items;
	},
	success: (message: string, opts?: ToastOptions) => push('success', message, opts),
	error: (message: string, opts?: ToastOptions) => push('error', message, opts),
	info: (message: string, opts?: ToastOptions) => push('info', message, opts),
	warning: (message: string, opts?: ToastOptions) => push('warning', message, opts),
	dismiss,
	clear(): void {
		for (const t of [...items]) dismiss(t.id);
	}
};
