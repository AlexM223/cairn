import { json } from '@sveltejs/kit';
import { requireAdmin, readJson } from '$lib/server/api';
import { getPublicInstanceSettings, setSetting } from '$lib/server/settings';
import { reconfigureChain } from '$lib/server/chain';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async (event) => {
	requireAdmin(event);
	return json({ settings: getPublicInstanceSettings() });
};

const KEY_MAP: Record<string, string> = {
	registrationMode: 'registration_mode',
	connectionMode: 'connection_mode',
	electrumHost: 'electrum_host',
	electrumPort: 'electrum_port',
	electrumTls: 'electrum_tls',
	esploraUrl: 'esplora_url',
	coreRpcUrl: 'core_rpc_url',
	coreRpcUser: 'core_rpc_user',
	coreRpcPass: 'core_rpc_pass'
};

export const PUT: RequestHandler = async (event) => {
	requireAdmin(event);
	const body = await readJson<Record<string, unknown>>(event);

	for (const [key, dbKey] of Object.entries(KEY_MAP)) {
		if (!(key in body)) continue;
		// An empty password means "keep the stored one" — it is never echoed
		// back to clients, so callers can't meaningfully resubmit it.
		if (key === 'coreRpcPass' && String(body[key]) === '') continue;
		setSetting(dbKey, String(body[key]));
	}
	reconfigureChain();

	return json({ settings: getPublicInstanceSettings() });
};
