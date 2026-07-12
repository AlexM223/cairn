import type { SessionUser } from '$lib/types';

declare global {
	namespace App {
		interface Error {
			message: string;
			/** Short id logged server-side; shown to the user so they can quote it. */
			errorId?: string;
			/**
			 * Duplicate of `message`, additive (Wave 6 / err-server.md §1). Every
			 * `.svelte` client reads `body?.error` (the hand-rolled-catch
			 * convention, ~100 call sites) — SvelteKit's own `error(status, 'msg')`
			 * only ever populated `message`, so a guard's specific reason (e.g.
			 * requireFeature's admin-set message) silently never reached a fetch
			 * caller, which fell back to its own generic string instead. Emitting
			 * both fields is the lowest-blast-radius fix: no client read-site has
			 * to change to start seeing the real message.
			 */
			error?: string;
		}
		interface Locals {
			user: SessionUser | null;
			/** Resolved feature flags for this request's user, keyed by flag id. */
			flags: Record<string, boolean>;
		}
		// interface PageData {}
		interface PageState {
			/** Which wizard screen this history entry represents, so the browser
			 *  Back button steps through a same-URL wizard one screen at a time
			 *  instead of leaving the flow (cairn-aiyw). Set via shallow routing
			 *  (pushState/replaceState) by the wallet-creation wizards. */
			wizardStep?: number;
		}
		// interface Platform {}
	}
}

export {};
