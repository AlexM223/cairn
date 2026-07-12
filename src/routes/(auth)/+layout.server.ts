import { redirect } from '@sveltejs/kit';
import { httpsExternalPort } from '$lib/server/httpsPort';
import { expectedPasskeyOrigin, passkeyAvailableOn } from '$lib/server/passkeyOrigin';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = async ({ locals, url }) => {
	if (locals.user) redirect(302, '/');
	return {
		// The secure-address port, so login/signup pages can auto-hop returning
		// users to the HTTPS origin too (cairn-6uff) — the hop is most valuable
		// exactly here, before sign-in.
		httpsPort: httpsExternalPort(),
		// SAFE mitigation for desktop passkey failures: whether a passkey
		// ceremony begun on THIS request's origin can verify server-side (see
		// $lib/server/passkeyOrigin.ts). Login/recover use this to hide the
		// passkey button/registration entry point on an origin where WebAuthn
		// is guaranteed to fail, and to name the origin where it does work.
		passkeyOriginOk: passkeyAvailableOn(url.origin),
		passkeyExpectedOrigin: expectedPasskeyOrigin(url.origin)
	};
};
