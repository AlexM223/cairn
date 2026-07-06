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
		// interface PageState {}
		// interface Platform {}
	}
}

export {};
