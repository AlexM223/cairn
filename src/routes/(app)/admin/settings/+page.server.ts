import { fail } from '@sveltejs/kit';
import { getInstanceSettings, setSetting } from '$lib/server/settings';
import { reconfigureChain, testElectrum, testEsplora } from '$lib/server/chain';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async () => {
	return { settings: getInstanceSettings() };
};

export const actions: Actions = {
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

		if (connectionMode === 'custom') {
			const host = String(form.get('electrumHost') ?? '').trim();
			const port = Number(form.get('electrumPort'));
			if (!host) return fail(400, { error: 'Electrum host is required in custom mode.' });
			if (!Number.isInteger(port) || port < 1 || port > 65535)
				return fail(400, { error: 'Electrum port must be between 1 and 65535.' });

			setSetting('electrum_host', host);
			setSetting('electrum_port', String(port));
			setSetting('electrum_tls', form.get('electrumTls') === 'on' ? 'true' : 'false');

			const esplora = String(form.get('esploraUrl') ?? '').trim();
			if (esplora && !/^https?:\/\//.test(esplora))
				return fail(400, { error: 'Esplora URL must start with http:// or https://.' });
			setSetting('esplora_url', esplora.replace(/\/+$/, ''));

			setSetting('core_rpc_url', String(form.get('coreRpcUrl') ?? '').trim());
			setSetting('core_rpc_user', String(form.get('coreRpcUser') ?? '').trim());
			setSetting('core_rpc_pass', String(form.get('coreRpcPass') ?? '').trim());
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
		if (!host || !Number.isInteger(port))
			return fail(400, { electrumTest: { ok: false, error: 'Enter a host and port first.' } });

		const result = await testElectrum({ host, port, tls });
		return { electrumTest: result };
	},

	testEsplora: async ({ request }) => {
		const form = await request.formData();
		const url = String(form.get('esploraUrl') ?? '').trim();
		if (!url)
			return fail(400, { esploraTest: { ok: false, error: 'Enter an Esplora URL first.' } });

		const result = await testEsplora(url.replace(/\/+$/, ''));
		return { esploraTest: result };
	}
};
