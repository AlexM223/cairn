import { fail, redirect } from '@sveltejs/kit';
import { getPublicInstanceSettings, setSetting } from '$lib/server/settings';
import { reconfigureChain, testElectrum, testEsplora } from '$lib/server/chain';
import { resetInstance } from '$lib/server/admin';
import { invalidateWalletCache } from '$lib/server/bitcoin/walletScan';
import { getUserAgreement, setUserAgreement } from '$lib/server/disclosures';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async () => {
	return { settings: getPublicInstanceSettings(), agreement: getUserAgreement() };
};

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
			// back to the form, so an untouched field must not clear it.
			const rpcPass = String(form.get('coreRpcPass') ?? '');
			if (rpcPass !== '') setSetting('core_rpc_pass', rpcPass);
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

		const result = await testElectrum({ host, port, tls, tlsInsecure });
		return { electrumTest: result };
	},

	testEsplora: async ({ request }) => {
		const form = await request.formData();
		const url = String(form.get('esploraUrl') ?? '').trim();
		if (!url)
			return fail(400, { esploraTest: { ok: false, error: 'Enter an Esplora URL first.' } });

		const result = await testEsplora(url.replace(/\/+$/, ''));
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
