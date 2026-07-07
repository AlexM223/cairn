import { json, requireUser, readJson } from '$lib/server/api';
import { listWallets, createWallet } from '$lib/server/wallets';
import type { RequestHandler } from './$types';

/** GET /api/wallets — all of the user's wallets with (cached) live balances. */
export const GET: RequestHandler = async (event) => {
	const user = requireUser(event);
	const { wallets, errors } = await listWallets(user.id);
	return json({ wallets, errors });
};

/**
 * POST /api/wallets { name?, xpub, deviceType?, fingerprint?, derivationPath? }
 * — import a single-sig wallet from an xpub. The key origin (master
 * fingerprint + account path) is what lets PSBTs carry bip32Derivation, which
 * every hardware signer needs (cairn-alw8); pass it via the two optional
 * fields, or embed it in the xpub itself in key-origin/descriptor form
 * (`[73c5da0a/84'/0'/0']zpub…`).
 */
export const POST: RequestHandler = async (event) => {
	const user = requireUser(event);
	const body = await readJson<{
		name?: string;
		xpub?: string;
		deviceType?: string;
		fingerprint?: string;
		derivationPath?: string;
	}>(event);
	try {
		const wallet = createWallet(user.id, {
			name: body.name,
			xpub: body.xpub,
			deviceType: body.deviceType,
			fingerprint: body.fingerprint,
			derivationPath: body.derivationPath
		});
		return json({ wallet }, { status: 201 });
	} catch (e) {
		return json(
			{ error: e instanceof Error ? e.message : 'Could not import that wallet.' },
			{ status: 400 }
		);
	}
};
