import { json } from '@sveltejs/kit';
import { requireAdmin, readJson } from '$lib/server/api';
import { getPublicInstanceSettings, setSetting, setSecretSetting } from '$lib/server/settings';
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
	electrumPoolSize: 'electrum_pool_size',
	socks5Host: 'socks5_host',
	socks5Port: 'socks5_port',
	coreRpcUrl: 'core_rpc_url',
	coreRpcUser: 'core_rpc_user',
	coreRpcPass: 'core_rpc_pass',
	// Which network the custom Electrum/Core RPC backend is on (cairn-10ox) —
	// gates xpub.ts's SLIP-132 prefix validation. Ignored in public mode.
	chainNetwork: 'chain_network'
};

// Mirrors the validation in the admin settings form action
// (src/routes/(app)/admin/settings/+page.server.ts). Without it, a scripted
// caller with an admin cookie could set registrationMode to a garbage value
// that matches neither the invite nor closed check in signup, silently falling
// through to fully-open registration; a non-numeric electrumPort becomes NaN and
// breaks the node connection. Returns an error string, or null if valid.
function validateSettings(body: Record<string, unknown>): string | null {
	if ('registrationMode' in body && !['open', 'invite', 'closed'].includes(String(body.registrationMode)))
		return 'Invalid registration mode.';

	if ('connectionMode' in body && !['public', 'custom'].includes(String(body.connectionMode)))
		return 'Invalid connection mode.';

	if ('chainNetwork' in body && !['mainnet', 'testnet', 'regtest'].includes(String(body.chainNetwork)))
		return 'Invalid chain network.';

	if ('electrumPort' in body) {
		const port = Number(body.electrumPort);
		if (!Number.isInteger(port) || port < 1 || port > 65535)
			return 'Electrum port must be an integer between 1 and 65535.';
	}

	if ('electrumPoolSize' in body) {
		const size = Number(body.electrumPoolSize);
		if (!Number.isInteger(size) || size < 1 || size > 4)
			return 'Electrum connections must be an integer between 1 and 4.';
	}

	// A SOCKS5 port only makes sense with a host, and vice versa: reject a
	// half-configured proxy that would silently do nothing.
	if ('socks5Port' in body && String(body.socks5Port).trim() !== '') {
		const port = Number(body.socks5Port);
		if (!Number.isInteger(port) || port < 1 || port > 65535)
			return 'SOCKS5 proxy port must be an integer between 1 and 65535.';
	}

	return null;
}

export const PUT: RequestHandler = async (event) => {
	requireAdmin(event);
	const body = await readJson<Record<string, unknown>>(event);

	const error = validateSettings(body);
	if (error) return json({ error }, { status: 400 });

	for (const [key, dbKey] of Object.entries(KEY_MAP)) {
		if (!(key in body)) continue;
		// An empty password means "keep the stored one" — it is never echoed
		// back to clients, so callers can't meaningfully resubmit it. A new
		// value is stored encrypted at rest (cairn-e9mz.3).
		if (key === 'coreRpcPass') {
			if (String(body[key]) !== '') setSecretSetting(dbKey, String(body[key]));
			continue;
		}
		setSetting(dbKey, String(body[key]));
	}
	// Mirrors the admin settings form action's provenance stamping (cairn
	// zero-config Core RPC wave §B/§E): a scripted admin caller setting
	// coreRpcUrl directly is just as much a manual action as typing it into
	// the form, and must stamp 'manual' (not leave provenance null) so
	// chainEnvSeed.ts's reconcile-on-boot never silently overwrites it later.
	if ('coreRpcUrl' in body) {
		setSetting('core_rpc_provisioned_by', String(body.coreRpcUrl).trim() ? 'manual' : '');
	}
	reconfigureChain();

	return json({ settings: getPublicInstanceSettings() });
};
