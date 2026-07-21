import { fail, redirect } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { deleteOwnAccount } from '$lib/server/accountDeletion';
import { AuthError } from '$lib/server/auth';
import { invalidateWalletCache } from '$lib/server/bitcoin/walletScan';
import {
	listCredentials,
	hasPassword,
	verifyPassword,
	setUserPassword,
	destroyUserSessions,
	createSession,
	setSessionCookie,
	getAuthMode,
	MIN_PASSWORD_LENGTH,
	DISPLAY_NAME_MAX
} from '$lib/server/auth';
import { hasRecoverySetup } from '$lib/server/recovery';
import { notify } from '$lib/server/notifications';
import { sessionContextFrom } from '$lib/server/deviceTracking';
import { expectedPasskeyOrigin, passkeyAvailableOn } from '$lib/server/passkeyOrigin';
import { requireUser, requireAdmin } from '$lib/server/api';
import { containsNulByte, graphemeLength } from '$lib/server/textGuard';
import {
	getPublicInstanceSettings,
	setSetting,
	setSecretSetting,
	readSecretSetting
} from '$lib/server/settings';
import { reconfigureChain, testElectrum, testCoreRpc, coreRpcUrlError } from '$lib/server/chain';
import { getChainHealth } from '$lib/server/chainHealth';
import { resetInstance } from '$lib/server/admin';
import { getUserAgreement, setUserAgreement } from '$lib/server/disclosures';
import { TextInputError } from '$lib/server/textGuard';
import { getGlobalFlags, setGlobalFlag } from '$lib/server/featureFlags/admin';
import { FEATURE_FLAGS_BY_KEY } from '$lib/server/featureFlags/registry';
import { recordActivity } from '$lib/server/activity';
import type { Actions, PageServerLoad } from './$types';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Resolved instance-wide value of a flag: the stored global row if present,
 *  else the registry default. This is the GLOBAL toggle state the admin group
 *  edits (not the per-user resolved value) — mining/explorer are instance-wide
 *  (spec §3.2/§4.1). */
function globalFlagEnabled(key: string): boolean {
	const row = getGlobalFlags().get(key);
	if (row !== undefined) return row;
	return FEATURE_FLAGS_BY_KEY.get(key)?.defaultEnabled ?? false;
}

export const load: PageServerLoad = async ({ locals, url }) => {
	const uid = locals.user!.id;
	// Passkeys are managed client-side against /api/auth/passkeys; the first
	// paint ships the current list.
	// Account-recovery (login recovery) status — drives the "Recovery" section
	// and the persistent warning banner until it's set up.
	const recovery = hasRecoverySetup(uid);

	// Admin-config groups (Node connection / Mining / Explorer / Instance) are
	// appended to this page ONLY for admins. Their backing data is gathered ONLY
	// inside this guard so a non-admin's page payload never carries any chain,
	// agreement, registration, or flag state (spec §4.2 / risk R1). In solo mode
	// the sole user is admin, so they legitimately see everything.
	const admin = locals.user?.isAdmin
		? {
				settings: getPublicInstanceSettings(),
				agreement: getUserAgreement(),
				chainHealth: getChainHealth(),
				miningEnabled: globalFlagEnabled('mining'),
				explorerEnabled: globalFlagEnabled('explorer')
			}
		: null;

	return {
		passkeys: listCredentials(uid),
		hasPassword: hasPassword(uid),
		authMode: getAuthMode(),
		recovery: {
			phrase: recovery.phrase,
			codesRemaining: recovery.codesRemaining,
			complete: recovery.phrase && recovery.codesRemaining > 0
		},
		// SAFE mitigation for desktop passkey failures: whether a passkey
		// registered from THIS request's origin would actually verify (see
		// $lib/server/passkeyOrigin.ts). "Add passkey" hides itself on an
		// origin where WebAuthn is guaranteed to fail — registering there
		// would create a passkey that never works, on any origin.
		passkeyOriginOk: passkeyAvailableOn(url.origin),
		passkeyExpectedOrigin: expectedPasskeyOrigin(url.origin),
		// null for non-admins — the admin groups (and every value they carry) are
		// simply absent from a regular user's page data.
		admin
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
	// ============================ Personal actions (any signed-in user) ========

	profile: async (event) => {
		requireUser(event);
		const { request, locals } = event;
		const form = await request.formData();
		const displayName = String(form.get('displayName') ?? '').trim();
		const email = String(form.get('email') ?? '').trim().toLowerCase();

		if (!displayName) return fail(400, { profileError: 'Display name is required.' });
		// cairn-l04v: same grapheme-cluster cap as registration's assertCanRegister
		// — this profile edit is the other write path to users.display_name and
		// was missing the cap entirely.
		if (graphemeLength(displayName) > DISPLAY_NAME_MAX)
			return fail(400, {
				profileError: `Display name must be ${DISPLAY_NAME_MAX} characters or fewer.`
			});
		if (containsNulByte(displayName))
			return fail(400, {
				profileError: 'Display name contains a NUL character (U+0000), which cannot be stored.'
			});
		if (!EMAIL_RE.test(email)) return fail(400, { profileError: 'Enter a valid email address.' });

		const taken = db
			.prepare('SELECT id FROM users WHERE email = ? AND id != ?')
			.get(email, locals.user!.id);
		if (taken) return fail(400, { profileError: 'That email is already in use.' });

		db.prepare('UPDATE users SET display_name = ?, email = ? WHERE id = ?').run(
			displayName,
			email,
			locals.user!.id
		);
		return { profileSaved: true };
	},

	password: async (event) => {
		requireUser(event);
		const { request, locals, cookies, url } = event;
		const form = await request.formData();
		const current = String(form.get('currentPassword') ?? '');
		const next = String(form.get('newPassword') ?? '');
		const confirm = String(form.get('confirmPassword') ?? '');
		const uid = locals.user!.id;

		if (next.length < MIN_PASSWORD_LENGTH)
			return fail(400, {
				passwordError: `New password must be at least ${MIN_PASSWORD_LENGTH} characters.`
			});
		if (next !== confirm) return fail(400, { passwordError: 'New passwords do not match.' });

		// Changing an existing password requires the current one; setting a first
		// password (passkey-only account) does not.
		if (hasPassword(uid)) {
			const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(uid) as
				| { password_hash: string | null }
				| undefined;
			if (!row?.password_hash || !(await verifyPassword(current, row.password_hash)))
				return fail(400, { passwordError: 'Current password is incorrect.' });
		}

		const wasExisting = hasPassword(uid);
		await setUserPassword(uid, next);

		// Security alert (cairn-5gpv.5): password is Cairn's default auth method, so a
		// silent change is a bigger blind spot than the new-passkey case webauthn.ts
		// already covers. Fire "was this you?" so an attacker who changes the password
		// to lock out the real owner leaves a signal on every enabled channel. Only for
		// an actual CHANGE — setting a first password on a passkey-only account is
		// expected and self-initiated. Best-effort: notify() never throws.
		if (wasExisting) {
			notify({
				type: 'security_password_changed',
				userId: uid,
				level: 'warn',
				title: 'Password changed',
				body: 'Your account password was just changed. If this wasn’t you, secure your account immediately — someone with access could lock you out.',
				link: '/settings'
			});
		}

		// Rotate all sessions: sign everything out, then start a fresh one here.
		// Pass the request context so the new session is recorded as this (already
		// known) device — no spurious new-device alert on top of the password one.
		destroyUserSessions(uid);
		const { token, expiresAt } = createSession(uid, sessionContextFrom(event));
		setSessionCookie(cookies, token, expiresAt, url);

		return { passwordSaved: true };
	},

	/**
	 * Danger zone (cairn-5u2i.2): delete the caller's OWN account after a typed
	 * confirmation, mirroring the admin reset-instance pattern. Everything the
	 * user owns goes; multisigs they merely participated in survive for their
	 * owner (only the share row is removed).
	 */
	deleteAccount: async (event) => {
		requireUser(event);
		const { request, locals } = event;
		const form = await request.formData();
		if (String(form.get('confirm') ?? '') !== 'DELETE')
			return fail(400, { deleteError: 'Type DELETE to confirm deleting your account.' });

		try {
			deleteOwnAccount(locals.user!.id);
		} catch (e) {
			if (e instanceof AuthError && e.code === 'last_admin') {
				return fail(400, { deleteError: e.message });
			}
			throw e;
		}
		invalidateWalletCache(); // drop cached scans for the deleted wallets

		// The account (and every session) is gone; the stale cookie fails auth.
		redirect(303, '/login');
	},

	// ============================ Admin-config actions =========================
	// Every one of these gates with requireAdmin(event) FIRST — /settings is not
	// under an admin layout, so the per-action guard is the real boundary that
	// keeps a non-admin (or anon) from reaching any instance mutation (spec §4.2,
	// risk R1). Moved verbatim from /admin/settings (spec §4.1 group 6/9).

	save: async (event) => {
		requireAdmin(event);
		const form = await event.request.formData();

		// Umbrel Wave B assisted-connect (cairn-ylz5 B2/B3, cairn-6uok follow-up
		// cairn-3p9z; docs/UMBREL-AUTOCONNECT-WAVE-B-DESIGN.md §6/§9): the
		// assisted-connect card posts to this same `save` action but is
		// distinguished by this hidden marker, so it doesn't need to carry every
		// other settings field the main forms do -- it returns early, before any of
		// those are read or validated, and it is the only save path that validates
		// with testCoreRpc() before persisting. Because it returns here,
		// connection_mode is never touched.
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
			setSetting('core_rpc_provisioned_by', 'umbrel-detect');
			reconfigureChain();
			return { saved: true, coreRpcTest: result };
		}

		// Registration mode (Instance group form) — only written when present, so
		// a Node-connection save doesn't clobber it back to the default. Absent
		// from payload = leave unchanged.
		if (form.has('registrationMode')) {
			const registrationMode = String(form.get('registrationMode') ?? 'invite');
			if (!['open', 'invite', 'closed'].includes(registrationMode))
				return fail(400, { error: 'Invalid registration mode.' });
			setSetting('registration_mode', registrationMode);
		}

		// Operator name is part of the user agreement (shown on /terms and the
		// acceptance screen). It lives in the Instance registration form so its
		// "Save" button persists it. Bumps the agreement version if it changed.
		const operatorName = form.get('operatorName');
		if (operatorName !== null) {
			try {
				setUserAgreement({ text: getUserAgreement().text, operator: String(operatorName) });
			} catch (e) {
				if (e instanceof TextInputError) return fail(400, { error: e.message });
				throw e;
			}
		}

		// Connection mode (Node connection form) — only written when present.
		let connectionMode: string | null = null;
		if (form.has('connectionMode')) {
			connectionMode = String(form.get('connectionMode') ?? 'public');
			if (!['public', 'custom'].includes(connectionMode))
				return fail(400, { error: 'Invalid connection mode.' });
			setSetting('connection_mode', connectionMode);
		}

		// Electrum connection-pool size — a client-side tuning knob independent of
		// which server is used, so it applies in both modes (cairn-ynfp). Only
		// written when present in the payload.
		if (form.has('electrumPoolSize')) {
			const poolSize = Number(form.get('electrumPoolSize'));
			if (!Number.isInteger(poolSize) || poolSize < 1 || poolSize > 4)
				return fail(400, { error: 'Electrum connections must be between 1 and 4.' });
			setSetting('electrum_pool_size', String(poolSize));
		}

		// SOCKS5/Tor proxy — applies in BOTH public and custom modes, so it lives
		// outside the custom-only block (cairn-oh7a). Only touched when at least
		// one proxy field is present in the payload, so an Instance-group save
		// (which carries no proxy fields) never clears a configured proxy.
		if (form.has('socks5Host') || form.has('socks5Port')) {
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
			// cairn-x6pr). Deliberately nested inside the custom-mode block:
			// getChainConfig() forces 'mainnet' unconditionally in public mode
			// regardless of what's stored, so the field only exists in the
			// custom-mode form render (mirrors the UI).
			const chainNetwork = String(form.get('chainNetwork') ?? '').trim();
			if (chainNetwork && !['mainnet', 'testnet', 'regtest'].includes(chainNetwork))
				return fail(400, { error: 'Invalid network.' });
			if (chainNetwork) setSetting('chain_network', chainNetwork);
		}

		// Bitcoin Core RPC is mode-independent (getChainConfig() returns coreRpc*
		// in BOTH 'public' and 'custom' modes; Core is "configured" purely by
		// whether core_rpc_url is set). Each key is only touched when its field is
		// actually PRESENT in the payload (form.has) — absent means "leave
		// unchanged," never "clear" (cairn-6uok).
		if (form.has('coreRpcUrl')) {
			const coreUrl = String(form.get('coreRpcUrl') ?? '').trim();
			if (coreUrl) {
				const urlErr = coreRpcUrlError(coreUrl);
				if (urlErr) return fail(400, { coreRpcTest: { ok: false, error: urlErr } });
			}
			setSetting('core_rpc_url', coreUrl);
			// A submission through these plain fields is a manual admin action.
			// Stamp 'manual' provenance so reconcile-on-boot never overwrites it
			// (manual > auto-env > detect > none). Clearing resets to "none."
			setSetting('core_rpc_provisioned_by', coreUrl ? 'manual' : '');
		}
		if (form.has('coreRpcUser')) {
			setSetting('core_rpc_user', String(form.get('coreRpcUser') ?? '').trim());
		}
		if (form.has('coreRpcPass')) {
			// Blank means "keep the stored password" — the secret is never echoed
			// back to the form. Stored encrypted at rest (cairn-e9mz.3).
			const rpcPass = String(form.get('coreRpcPass') ?? '');
			if (rpcPass !== '') setSecretSetting('core_rpc_pass', rpcPass);
		}
		if (form.get('clearCoreRpcPass') === 'on') setSecretSetting('core_rpc_pass', '');

		// Apply the new connection immediately — no restart needed.
		reconfigureChain();

		return { saved: true };
	},

	saveAgreement: async (event) => {
		requireAdmin(event);
		const form = await event.request.formData();
		const text = String(form.get('agreementText') ?? '');
		// The operator name is edited (and saved) in the registration form; keep
		// the current one here so this button only touches the agreement text.
		try {
			const saved = setUserAgreement({ text, operator: getUserAgreement().operator });
			return { agreementSaved: true, agreementVersion: saved.version };
		} catch (e) {
			if (e instanceof TextInputError) return fail(400, { error: e.message });
			throw e;
		}
	},

	testElectrum: async (event) => {
		requireAdmin(event);
		const form = await event.request.formData();
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

	testCoreRpc: async (event) => {
		requireAdmin(event);
		const form = await event.request.formData();
		const url = String(form.get('coreRpcUrl') ?? '').trim();
		if (!url)
			return fail(400, { coreRpcTest: { ok: false, error: 'Enter a Bitcoin Core RPC URL first.' } });

		const user = String(form.get('coreRpcUser') ?? '').trim() || null;
		// The password field is left blank when keeping the stored secret (never
		// echoed back), so fall back to the persisted one — otherwise "Test
		// connection" would fail for an already-saved node unless the admin
		// re-typed the password (mirrors ?/save's blank-means-keep convention).
		const typed = String(form.get('coreRpcPass') ?? '');
		const pass = typed !== '' ? typed : readSecretSetting('core_rpc_pass');

		const result = await testCoreRpc({ url, user, pass });
		return { coreRpcTest: result };
	},

	/**
	 * Umbrel Wave B assisted-connect "Dismiss" (cairn-ylz5 B3, cairn-3p9z):
	 * writes the seed-once-respecting `'dismissed'` value over the advisory
	 * `core_rpc_detected` marker so the assisted-connect card stops rendering.
	 * Purely cosmetic — never consulted by the live connection.
	 */
	dismissCoreDetection: async (event) => {
		requireAdmin(event);
		setSetting('core_rpc_detected', 'dismissed');
		return { coreRpcDismissed: true };
	},

	/**
	 * "Switch to manual" override on the read-only auto-connected Core RPC card
	 * (cairn zero-config Core RPC wave §E). Stamps a real `'manual'` value so the
	 * next boot's env reconcile (manual > auto-env > detect > none) never
	 * silently re-stamps and overwrites hand-edits. Leaves the stored
	 * url/user/pass as-is — only changes WHO owns the field going forward.
	 */
	switchCoreRpcToManual: async (event) => {
		requireAdmin(event);
		setSetting('core_rpc_provisioned_by', 'manual');
		return { coreRpcSwitchedToManual: true };
	},

	unlockTeamMode: async (event) => {
		requireAdmin(event);
		setSetting('instance_mode', 'team');
		return { instanceModeSaved: true };
	},

	/**
	 * Non-destructive: only re-hides the nav. Existing users, invites, contacts,
	 * and multisig shares are untouched; a shared-with cosigner's own access
	 * keeps working — only the owner-side management surfaces hide again
	 * (cairn-7t0z.5).
	 */
	lockTeamMode: async (event) => {
		requireAdmin(event);
		setSetting('instance_mode', 'solo');
		return { instanceModeSaved: true };
	},

	/**
	 * Mining / Explorer instance toggles (spec §3.2/§4.1). These write the SAME
	 * global `feature_flags` rows the old /admin/feature-flags grid wrote, via
	 * the same `setGlobalFlag()` path, and record the same `admin_feature_flag`
	 * audit event — this is what keeps requireFeature, nav visibility, and the
	 * stratum listener in lockstep. Only `mining`/`explorer` are toggleable here;
	 * the other 23 flags are code-only (registry defaults), no UI.
	 */
	toggleFlag: async (event) => {
		const admin = requireAdmin(event);
		const form = await event.request.formData();
		const key = String(form.get('key') ?? '');
		if (key !== 'mining' && key !== 'explorer')
			return fail(400, { error: 'Only mining and explorer can be toggled here.' });
		const enabled = form.get('enabled') === 'true';
		const def = FEATURE_FLAGS_BY_KEY.get(key);
		if (!def) return fail(400, { error: 'Unknown feature flag.' });

		// Capture the prior global value BEFORE writing, for the audit trail.
		// undefined = no row yet → the flag was inheriting its registry default.
		const prevRow = getGlobalFlags().get(key);
		const from = prevRow === undefined ? 'default' : prevRow ? 'on' : 'off';
		const to = enabled ? 'on' : 'off';

		setGlobalFlag(key, enabled, admin.id);

		recordActivity({
			type: 'admin_feature_flag',
			userId: null,
			level: enabled ? 'info' : 'warn',
			message: `${admin.email} ${enabled ? 'enabled' : 'disabled'} "${def.label}" instance-wide`,
			detail: { adminId: admin.id, flag: key, scope: 'global', from, to }
		});
		return { flagToggled: true, key, enabled };
	},

	resetInstance: async (event) => {
		requireAdmin(event);
		const form = await event.request.formData();
		if (String(form.get('confirm') ?? '') !== 'RESET')
			return fail(400, { error: 'Type RESET to confirm the instance reset.' });

		resetInstance();
		invalidateWalletCache(); // no args — drop every cached wallet scan

		// Everything (including the caller's session) is gone; /signup is now the
		// first-run setup flow again.
		redirect(303, '/signup');
	}
};
