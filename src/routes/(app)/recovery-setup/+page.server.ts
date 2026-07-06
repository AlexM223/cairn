import { redirect } from '@sveltejs/kit';
import { hasRecoverySetup } from '$lib/server/recovery';
import type { PageServerLoad } from './$types';

// The mandatory ACCOUNT-recovery setup wizard, shown right after a user adds
// their first passkey. It sets up a way to get back INTO Cairn (the LOGIN) if
// every passkey is lost — it has NOTHING to do with bitcoin keys, which live on
// the hardware wallet.
//
// Access rules:
//   • Admins CANNOT skip: the whole point is that the instance operator stays
//     recoverable. If they somehow leave with recovery incomplete, the settings
//     banner keeps nagging and re-entry lands them right back here.
//   • Regular users MAY skip (a dismissible-only-by-completing warning banner in
//     Settings reminds them until it's done).
//   • If recovery is ALREADY complete, there's nothing to do here — bounce to
//     Settings so this page can't be used to needlessly regenerate secrets by
//     accident (regeneration is still explicit from Settings).

export const load: PageServerLoad = async ({ locals, url }) => {
	const user = locals.user!;
	const status = hasRecoverySetup(user.id);
	const complete = status.phrase && status.codesRemaining > 0;

	// Already set up: don't re-run the mandatory wizard. `?force=1` lets Settings
	// deliberately reopen it to regenerate.
	if (complete && url.searchParams.get('force') !== '1') {
		redirect(303, '/settings');
	}

	return {
		isAdmin: user.isAdmin,
		status
	};
};
