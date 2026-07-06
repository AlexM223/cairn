import { fail, redirect } from '@sveltejs/kit';
import { getPublicInstanceSettings, setSetting, setSecretSetting } from '$lib/server/settings';
import { reconfigureChain, testElectrum, testEsplora } from '$lib/server/chain';
import { resetInstance } from '$lib/server/admin';
import { invalidateWalletCache } from '$lib/server/bitcoin/walletScan';
import { getUserAgreement, setUserAgreement } from '$lib/server/disclosures';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async () => {
	return { settings: getPublicInstanceSettings(), agreement: getUserAgreement() };
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
		const saved = setUserAgreement({ text, operator: getUserAgreement().operator });
		// Report whether this bumped the version (so existing users re-accept).
		return { agreementSaved: true, agreementVersion: saved.version };
	},

	save: async ({ request }) => {
		const form = await request.formData();

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
			setUserAgreement({ text: getUserAgreement().text, operator: String(operatorName) });
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

			const esplora = String(form.get('esploraUrl') ?? '').trim();
			if (esplora && !/^https?:\/\//.test(esplora))
				return fail(400, { error: 'Esplora URL must start with http:// or https://.' });
			setSetting('esplora_url', esplora.replace(/\/+$/, ''));

			setSetting('core_rpc_url', String(form.get('coreRpcUrl') ?? '').trim());
			setSetting('core_rpc_user', String(form.get('coreRpcUser') ?? '').trim());
			// Blank means "keep the stored password" — the secret is never echoed
			// back to the form, so an untouched field must not clear it. Stored
			// encrypted at rest (cairn-e9mz.3).
			const rpcPass = String(form.get('coreRpcPass') ?? '');
			if (rpcPass !== '') setSecretSetting('core_rpc_pass', rpcPass);
			if (form.get('clearCoreRpcPass') === 'on') setSetting('core_rpc_pass', '');
		}

		// Apply the new connection immediately — no restart needed.
		reconfigureChain();

		return { saved: true };
	},

	testElectrum: async ({ request }) => {
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

	testEsplora: async ({ request }) => {
		const form = await request.formData();
		const url = String(form.get('esploraUrl') ?? '').trim();
		if (!url)
			return fail(400, { esploraTest: { ok: false, error: 'Enter an Esplora URL first.' } });

		const proxy = readProxyFromForm(form);
		const result = await testEsplora(url.replace(/\/+$/, ''), proxy);
		return { esploraTest: result };
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
