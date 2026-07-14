import { fail } from '@sveltejs/kit';
import { parseXpub } from '$lib/server/bitcoin/xpub';
import { derivePreviewAddresses } from '$lib/server/bitcoin/walletScan';
import { createWallet, friendlyXpubError } from '$lib/server/wallets';
import { getReferralBuyUrls } from '$lib/server/referrals';
import { parseKeyOriginInput, normalizeFingerprint } from '$lib/hw/keyOrigin';
import { rememberPrefetchedSharedKey, DeviceKeyError } from '$lib/server/deviceKeys';
import { requireFeature, requireUser } from '$lib/server/api';
import type { Actions, PageServerLoad } from './$types';

// Server-side mirror of the wizard's device-card gating (cairn-cl13): a
// device-sourced wallet may only be created while its driver's flag is on, so a
// hand-crafted POST can't bypass a disabled hw_* flag the way the client picker
// is filtered. 'file'/paste (empty deviceType) is the universal fallback and
// stays ungated; unknown values fall through ungated rather than throwing.
const DEVICE_TYPE_FLAG: Record<string, string> = {
	trezor: 'hw_trezor',
	ledger: 'hw_ledger',
	coldcard: 'hw_coldcard',
	bitbox02: 'hw_bitbox02',
	jade: 'hw_jade',
	qr: 'qr_scan'
};

export const load: PageServerLoad = async ({ locals }) => {
	return {
		// Resolved buy-a-device links for the method picker. null when the
		// referral_links flag is off — the wizard then renders no referral UI at
		// all (the client keys purely off URL presence).
		referralBuyUrls: getReferralBuyUrls(locals.flags)
	};
};

export const actions: Actions = {
	/**
	 * Step 2 → 3: validate the pasted key and derive the first 5 receive
	 * addresses. The key field accepts descriptor / key-origin form
	 * (`[73c5da0a/84'/0'/0']zpub…`) as well as a bare xpub — the embedded
	 * origin is extracted and handed back so the wizard can store it on the
	 * wallet, which is what makes hardware signing possible later
	 * (cairn-alw8). An optional `fingerprint` field covers wallets that
	 * export only the bare key plus a "master fingerprint"/XFP label.
	 */
	preview: async (event) => {
		requireUser(event);
		const { request } = event;
		const form = await request.formData();
		const raw = String(form.get('xpub') ?? '').trim();
		const parsedInput = parseKeyOriginInput(raw);

		// The typed fingerprint only fills in when the key itself didn't carry
		// one. Non-empty garbage fails loudly: silently dropping a typo would
		// quietly re-create the broken-signing state.
		let fingerprint = parsedInput.fingerprint;
		const fpRaw = String(form.get('fingerprint') ?? '').trim();
		if (!fingerprint && fpRaw && !/^0{8}$/.test(fpRaw)) {
			fingerprint = normalizeFingerprint(fpRaw);
			if (!fingerprint) {
				return fail(400, {
					error:
						"That master fingerprint doesn't look right — it's exactly 8 characters of 0-9 and a-f, like 73c5da0a."
				});
			}
		}

		try {
			const parsed = parseXpub(parsedInput.xpub);
			return {
				preview: derivePreviewAddresses(parsedInput.xpub, 5),
				scriptType: parsed.scriptType,
				xpub: parsedInput.xpub,
				fingerprint,
				path: parsedInput.path
			};
		} catch (e) {
			return fail(400, { error: friendlyXpubError(e) });
		}
	},

	/**
	 * Create the wallet, then hand the id back so the wizard can require a config
	 * backup download before finishing (cairn-dcp) — no redirect here.
	 */
	create: async (event) => {
		requireUser(event);
		const { request, locals } = event;
		const form = await request.formData();
		const xpub = String(form.get('xpub') ?? '').trim();
		const name = String(form.get('name') ?? '').trim();
		// Empty string = the user skipped it; createWallet normalizes to null.
		const deviceType = String(form.get('deviceType') ?? '').trim();
		// Defense-in-depth: reject a device-sourced wallet whose driver flag an
		// admin disabled, even if the request bypassed the filtered client picker
		// (cairn-cl13). requireFeature throws a 403 with the flag's userMessage.
		const deviceFlag = DEVICE_TYPE_FLAG[deviceType];
		if (deviceFlag) requireFeature(event, deviceFlag);
		// Key origin captured on the Key step (device read, ColdCard export, or
		// parsed out of a pasted descriptor). Empty = unknown; the wallet then
		// signs only via the file/PSBT passthrough (cairn-alw8).
		const fingerprint = String(form.get('fingerprint') ?? '').trim();
		const derivationPath = String(form.get('derivationPath') ?? '').trim();

		let id: number;
		try {
			id = createWallet(locals.user!.id, {
				name,
				xpub,
				deviceType,
				fingerprint,
				derivationPath
			}).id;
		} catch (e) {
			return fail(400, {
				error: e instanceof Error ? e.message : 'Could not import that wallet.'
			});
		}
		return { created: true, id };
	},

	/**
	 * Stash a BIP-45 sharing key the wizard just prefetched off a live device
	 * (the "I plan to use this key in a shared wallet later" opt-in —
	 * cairn-fdlf.1) into the known-device-keys registry (cairn-fdlf.2), along
	 * with the primary single-sig key from the same read (best-effort). Wholly
	 * independent of wallet creation: a failure here never blocks the wizard —
	 * the client shows a soft notice and moves on.
	 */
	rememberSharedKey: async (event) => {
		requireUser(event);
		const { request, locals } = event;
		const form = await request.formData();
		const field = (name: string) => String(form.get(name) ?? '').trim();

		const primaryXpub = field('primaryXpub');
		try {
			const { shared, primary } = rememberPrefetchedSharedKey(locals.user!.id, {
				shared: {
					xpub: field('sharedXpub'),
					fingerprint: field('sharedFingerprint'),
					path: field('sharedPath')
				},
				primary: primaryXpub
					? {
							xpub: primaryXpub,
							fingerprint: field('primaryFingerprint'),
							path: field('primaryPath')
						}
					: null,
				deviceType: field('deviceType')
			});
			return {
				remembered: true,
				fingerprint: shared.fingerprint,
				primaryRemembered: primary !== null
			};
		} catch (e) {
			return fail(400, {
				error:
					e instanceof DeviceKeyError ? e.message : 'Could not save the sharing key.'
			});
		}
	}
};
