import type { SessionUser } from '$lib/types';

declare global {
	namespace App {
		interface Error {
			message: string;
			/** Short id logged server-side; shown to the user so they can quote it. */
			errorId?: string;
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
