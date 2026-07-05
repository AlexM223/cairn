import { json, requireUser } from '$lib/server/api';
import { getMultisig } from '$lib/server/wallets/multisig';
import { coldcardRegistration } from '$lib/server/multisigExport';
import { MultisigError } from '$lib/server/bitcoin/multisig';
import { markBackedUp } from '$lib/server/backups';
import type { RequestHandler } from './$types';
import { childLogger } from '$lib/server/logger';

const log = childLogger('wallet');

function safeFilename(name: string): string {
	const slug = name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 40);
	return slug || 'multisig';
}

/**
 * GET /api/wallets/multisig/:id/coldcard — the ColdCard multisig registration file
 * (also accepted by Passport, Keystone, SeedSigner). Air-gapped devices must
 * import this before they will co-sign for the multisig.
 */
export const GET: RequestHandler = async (event) => {
	const user = requireUser(event);
	const id = Number(event.params.id);
	const multisig = Number.isInteger(id) && id > 0 ? getMultisig(user.id, id) : null;
	if (!multisig) return json({ error: 'Multisig not found' }, { status: 404 });

	try {
		const body = coldcardRegistration(multisig);
		markBackedUp(user.id, 'multisig', id);
		return new Response(body, {
			headers: {
				'content-type': 'text/plain; charset=utf-8',
				'content-disposition': `attachment; filename="cairn-multisig-${safeFilename(multisig.name)}-coldcard.txt"`
			}
		});
	} catch (e) {
		if (!(e instanceof MultisigError)) {
			log.error({ err: e, multisigId: id }, 'wallet coldcard export failed');
		}
		const message =
			e instanceof MultisigError ? e.message : 'Could not build the ColdCard registration file.';
		return json({ error: message }, { status: 500 });
	}
};
