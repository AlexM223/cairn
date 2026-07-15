import { fail, redirect } from '@sveltejs/kit';
import {
	getPublicInstanceSettings,
	setSetting,
	setSecretSetting,
	readSecretSetting
} from '$lib/server/settings';
import { reconfigureChain, testElectrum, testCoreRpc, coreRpcUrlError } from '$lib/server/chain';
import { getChainHealth } from '$lib/server/chainHealth';
import { resetInstance } from '$lib/server/admin';
import { invalidateWalletCache } from '$lib/server/bitcoin/walletScan';
import { getUserAgreement, setUserAgreement } from '$lib/server/disclosures';
import { TextInputError } from '$lib/server/textGuard';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async () => {
	// chainHealth is a cheap in-memory read (last-known transport state, no probe);
	// it drives the live proxy/connection indicator next to the proxy config so an
	// admin can see at a glance whether the proxy is rejecting connections (cairn-hy8z).
	return {
		settings: getPublicInstanceSettings(),
		agreement: getUserAgreement(),
		chainHealth: getChainHealth()
	};
};

/** Parse the optional SOCKS5 proxy fields from a settings form submission. */
function readProxyFromForm(form: FormData): {
	socks5Host: string | null;
	socks5Port: number | null;
} {
	const host = String(form.get('socks5Host') ?? '').trim();
	const portRaw = String(form.get('socks5Port') ?? '').trim();
	const port = Number(portRaw);
	if (!host || !portRaw || !Number.isInteger(port)) return { socks5Host: null, socks5Port: null };
	return { socks5Host: host, socks5Port: port };
}

export const actions: Actions = {
	saveAgreement: async ({ request, locals }) => {
		if (!locals.user?.isAdmin) return fail(403, { error: 'Admin access required.' });
		const form = await request.formData();
		const text = String(form.get('agreementText') ?? '');
		// The operator name is edited (and saved) in the main settings form; keep
		// the current one here so this button only touches the agreement text.
		try {
			const saved = setUserAgreement({ text, operator: getUserAgreement().operator });
			// Report whether this bumped the version (so existing users re-accept).
			return { agreementSaved: true, agreementVersion: saved.version };
		} catch (e) {
			if (e instanceof TextInputError) return fail(400, { error: e.message });
			throw e;
		}
	},

	save: async ({ request, locals }) => {
		if (!locals.user?.isAdmin) return fail(403, { error: 'Admin access required.' });
		const form = await request.formData();

		// Umbrel Wave B assisted-connect (cairn-ylz5 B2/B3, cairn-6uok follow-up
		// cairn-3p9z; docs/UMBREL-AUTOCONNECT-WAVE-B-DESIGN.md §6/§9): the
		// assisted-connect card posts to this same `save` action but is
		// distinguished by this hidden marker, so it doesn't need to carry every
		// other settings field (registrationMode/connectionMode/electrumPoolSize/
		// etc) the main form does -- it returns early, before any of those are
		// read or validated, and it is the only save path that validates with
		// testCoreRpc() before persisting (matching the design doc's "run
		// testCoreRpc() before persisting" requirement). Because it returns here,
		// connection_mode is never touched, satisfying "must not force-flip the
		// operator's Electrum connection_mode to custom as a side effect of
		// connecting Core."
		if (form.get('coreRpcAssisted') === 'umbrel') {
			const url = String(form.get('coreRpcUrl') ?? '').trim();
			const user = String(form.get('coreRpcUser') ?? '').trim() || null;
			const pass = String(form.get('coreRpcPass') ?? '');
			if (!url || !pass)
				return fail(400, {
					coreRpcTest: { ok: false, error: 'Enter the Bitcoin Core RPC URL and password.' }
				});

			const result = await testCoreRpc({ url, user, pass });
			if (!result.ok) return fail(400, { coreRpcTest: result });

			setSetting('core_rpc_url', url);
			setSetting('core_rpc_user', user ?? '');
			setSecretSetting('core_rpc_pass', pass);
			// Post-connect provenance (design doc §6), separate from Electrum's
			// chain_provisioned_by -- lets the card distinguish "detected but not
			// yet connected" from "assisted-connected."
			setSetting('core_rpc_provisioned_by', 'umbrel-detect');
			reconfigureChain();
			return { saved: true, coreRpcTest: result };
		}

		const registrationMode = String(form.get('registrationMode') ?? 'invite');
		if (!['open', 'invite', 'closed'].includes(registrationMode))
			return fail(400, { error: 'Invalid registration mode.' });

		const connectionMode = String(form.get('connectionMode') ?? 'public');
		if (!['public', 'custom'].includes(connectionMode))
			return fail(400, { error: 'Invalid connection mode.' });

		setSetting('registration_mode', registrationMode);
		setSetting('connection_mode', connectionMode);

		// Operator name is part of the user agreement (shown on /terms and the
		// acceptance screen). It lives in this main form so the primary "Save
		// settings" button persists it — the previous separate-form-only field was
		// easy to miss (cairn-kc4e). Bumps the agreement version if it changed.
		const operatorName = form.get('operatorName');
		if (operatorName !== null) {
			try {
				setUserAgreement({ text: getUserAgreement().text, operator: String(operatorName) });
			} catch (e) {
				if (e instanceof TextInputError) return fail(400, { error: e.message });
				throw e;
			}
		}

		// Electrum connection-pool size — a client-side tuning knob independent of
		// which server is used, so it applies in both modes (cairn-ynfp).
		const poolSize = Number(form.get('electrumPoolSize'));
		if (!Number.isInteger(poolSize) || poolSize < 1 || poolSize > 4)
			return fail(400, { error: 'Electrum connections must be between 1 and 4.' });
		setSetting('electrum_pool_size', String(poolSize));

		// SOCKS5/Tor proxy — applies in BOTH public and custom modes, so it lives
		// outside the custom-only block (cairn-oh7a). Both fields set → enable; both
		// blank → disable (stored as empty, which loads back as null).
		const socks5Host = String(form.get('socks5Host') ?? '').trim();
		const socks5PortRaw = String(form.get('socks5Port') ?? '').trim();
		if (socks5Host || socks5PortRaw) {
			const socks5Port = Number(socks5PortRaw);
			if (!socks5Host)
				return fail(400, {
					error: 'Enter a SOCKS5 proxy host, or clear the port to connect directly.'
				});
			if (!Number.isInteger(socks5Port) || socks5Port < 1 || socks5Port > 65535)
				return fail(400, { error: 'SOCKS5 proxy port must be between 1 and 65535.' });
			setSetting('socks5_host', socks5Host);
			setSetting('socks5_port', String(socks5Port));
		} else {
			setSetting('socks5_host', '');
			setSetting('socks5_port', '');
		}

		if (connectionMode === 'custom') {
			const host = String(form.get('electrumHost') ?? '').trim();
			const port = Number(form.get('electrumPort'));
			if (!host) return fail(400, { error: 'Electrum host is required in custom mode.' });
			if (!Number.isInteger(port) || port < 1 || port > 65535)
				return fail(400, { error: 'Electrum port must be between 1 and 65535.' });

			setSetting('electrum_host', host);
			setSetting('electrum_port', String(port));
			setSetting('electrum_tls', form.get('electrumTls') === 'on' ? 'true' : 'false');
			// Certificate validation is ON unless the admin explicitly opts out for a
			// self-signed custom server (cairn-azei).
			setSetting(
				'electrum_tls_insecure',
				form.get('electrumTlsInsecure') === 'on' ? 'true' : 'false'
			);

			// Which network the custom backend is actually on (cairn-10ox /
			// cairn-x6pr). Deliberately nested inside the custom-mode block, not
			// written unconditionally like the mode-independent Core RPC fields
			// below: getChainConfig() forces 'mainnet' unconditionally in public
			// mode regardless of what's stored, so the field only exists in the
			// custom-mode form render (mirrors the UI).
			const chainNetwork = String(form.get('chainNetwork') ?? '').trim();
			if (chainNetwork && !['mainnet', 'testnet', 'regtest'].includes(chainNetwork))
				return fail(400, { error: 'Invalid network.' });
			if (chainNetwork) setSetting('chain_network', chainNetwork);
		}

		// Bitcoin Core RPC is a separate concern from connectionMode/Electrum
		// (Wave B design doc section 4 -- getChainConfig() returns coreRpc* in
		// BOTH 'public' and 'custom' modes; there is no public-mode Core
		// fallback, so Core is "configured" purely by whether core_rpc_url is
		// set). These three writes used to live inside the
		// `connectionMode === 'custom'` block above, which meant (a) a
		// 'public'-mode admin's Core RPC submission -- e.g. the Umbrel
		// assisted-connect flow -- was silently dropped, never persisted at
		// all, and (b) the JSON endpoint (api/admin/settings/+server.ts)
		// already wrote these fields unconditionally, so the two save paths
		// disagreed (cairn-6uok).
		//
		// They now run for every submission, but each key is only touched
		// when its field is actually PRESENT in the payload (form.has, not
		// `?? ''`). A non-custom-mode render (or any future submission, like
		// an assisted-connect mini-form, that doesn't include these inputs)
		// must leave the stored values untouched -- absent-from-payload means
		// "leave unchanged," never "clear." An explicit clear is still
		// possible: submit the field present-but-empty, or (for the
		// password) the clearCoreRpcPass marker.
		if (form.has('coreRpcUrl')) {
			const coreUrl = String(form.get('coreRpcUrl') ?? '').trim();
			// A present-but-empty field clears Core config; a non-empty one must be a
			// valid absolute http(s) URL, or we'd persist a value that later leaks a
			// SvelteKit-internal fetch error on every explorer load (cairn-mf9i).
			if (coreUrl) {
				const urlErr = coreRpcUrlError(coreUrl);
				if (urlErr) return fail(400, { coreRpcTest: { ok: false, error: urlErr } });
			}
			setSetting('core_rpc_url', coreUrl);
		}
		if (form.has('coreRpcUser')) {
			setSetting('core_rpc_user', String(form.get('coreRpcUser') ?? '').trim());
		}
		if (form.has('coreRpcPass')) {
			// Blank means "keep the stored password" -- the secret is never
			// echoed back to the form, so an untouched-but-present field must
			// not clear it either. Stored encrypted at rest (cairn-e9mz.3).
			const rpcPass = String(form.get('coreRpcPass') ?? '');
			if (rpcPass !== '') setSecretSetting('core_rpc_pass', rpcPass);
		}
		if (form.get('clearCoreRpcPass') === 'on') setSecretSetting('core_rpc_pass', '');

		// Apply the new connection immediately — no restart needed.
		reconfigureChain();

		return { saved: true };
	},

	testElectrum: async ({ request, locals }) => {
		if (!locals.user?.isAdmin) return fail(403, { error: 'Admin access required.' });
		const form = await request.formData();
		const host = String(form.get('electrumHost') ?? '').trim();
		const port = Number(form.get('electrumPort'));
		const tls = form.get('electrumTls') === 'on';
		const tlsInsecure = form.get('electrumTlsInsecure') === 'on';
		if (!host || !Number.isInteger(port))
			return fail(400, { electrumTest: { ok: false, error: 'Enter a host and port first.' } });

		// Test through the proxy too, so the result reflects real connectivity.
		const { socks5Host, socks5Port } = readProxyFromForm(form);
		const result = await testElectrum({ host, port, tls, tlsInsecure, socks5Host, socks5Port });
		return { electrumTest: result };
	},

	testCoreRpc: async ({ request, locals }) => {
		if (!locals.user?.isAdmin) return fail(403, { error: 'Admin access required.' });
		const form = await request.formData();
		const url = String(form.get('coreRpcUrl') ?? '').trim();
		if (!url)
			return fail(400, { coreRpcTest: { ok: false, error: 'Enter a Bitcoin Core RPC URL first.' } });

		const user = String(form.get('coreRpcUser') ?? '').trim() || null;
		// The password field is left blank when the admin is keeping the stored
		// secret (it is never echoed back to the form), so fall back to the
		// persisted one — otherwise "Test connection" would fail for an already-
		// saved node unless the admin re-typed the password (mirrors ?/save's
		// blank-means-keep convention).
		const typed = String(form.get('coreRpcPass') ?? '');
		const pass = typed !== '' ? typed : readSecretSetting('core_rpc_pass');

		const result = await testCoreRpc({ url, user, pass });
		return { coreRpcTest: result };
	},

	/**
	 * Umbrel Wave B assisted-connect "Dismiss" (cairn-ylz5 B3, cairn-3p9z;
	 * design doc §8 "Core uninstalled later" mitigation): writes the seed-once
	 * respecting `'dismissed'` value over the advisory `core_rpc_detected`
	 * marker so the assisted-connect card stops rendering. Purely cosmetic —
	 * `core_rpc_detected` is never consulted by getChainConfig() / the live
	 * connection, so this can never break anything already connected.
	 */
	dismissCoreDetection: async ({ locals }) => {
		if (!locals.user?.isAdmin) return fail(403, { error: 'Admin access required.' });
		setSetting('core_rpc_detected', 'dismissed');
		return { coreRpcDismissed: true };
	},

	unlockTeamMode: async ({ locals }) => {
		if (!locals.user?.isAdmin) return fail(403, { error: 'Admin access required.' });
		setSetting('instance_mode', 'team');
		return { instanceModeSaved: true };
	},

	/**
	 * Non-destructive: only re-hides the nav. Existing users, invites, contacts,
	 * and multisig shares are untouched, and a shared-with cosigner's own access
	 * to a wallet keeps working — only the owner-side management surfaces
	 * disappear again (cairn-7t0z.5).
	 */
	lockTeamMode: async ({ locals }) => {
		if (!locals.user?.isAdmin) return fail(403, { error: 'Admin access required.' });
		setSetting('instance_mode', 'solo');
		return { instanceModeSaved: true };
	},

	resetInstance: async ({ request, locals }) => {
		// The admin layout already gates this route, but a factory reset deserves
		// a second, explicit check.
		if (!locals.user?.isAdmin) return fail(403, { error: 'Admin access required.' });

		const form = await request.formData();
		if (String(form.get('confirm') ?? '') !== 'RESET')
			return fail(400, { error: 'Type RESET to confirm the instance reset.' });

		resetInstance();
		invalidateWalletCache(); // no args — drop every cached wallet scan

		// Everything (including the caller's session) is gone; /signup is now the
		// first-run setup flow again.
		redirect(303, '/signup');
	}
};
