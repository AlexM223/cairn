import { json } from '@sveltejs/kit';
import { requireAdmin, readJson } from '$lib/server/api';
import { listUsers, getUser, setUserAdmin, setUserDisabled, deleteUser } from '$lib/server/admin';
import { AuthError, hasNoCredentials, hasPassword } from '$lib/server/auth';
import { mintAdminRecoveryCode } from '$lib/server/recovery';
import { recordActivity } from '$lib/server/activity';
import { notify } from '$lib/server/notifications';
import { childLogger } from '$lib/server/logger';
import type { RequestHandler } from './$types';

const log = childLogger('admin');

export const GET: RequestHandler = async (event) => {
	requireAdmin(event);
	return json({ users: listUsers() });
};

/**
 * POST { id, disabled?, isAdmin? } — update a user's flags.
 * POST { id, mintRecoveryCode: true } — mint a single-use recovery code for a
 * restored account (cairn-j1q9). This is the out-of-band replacement for the
 * removed public "reclaim by email" signup path: a backup restore leaves an
 * imported account with no password and no passkeys, so this is the only way
 * an admin can hand its owner a way back in. Mutually exclusive with the flag
 * updates above — if `mintRecoveryCode` is present the request is handled as
 * a mint and any `disabled`/`isAdmin` fields are ignored.
 */
export const POST: RequestHandler = async (event) => {
	const admin = requireAdmin(event);
	const body = await readJson<{
		id?: number;
		disabled?: boolean;
		isAdmin?: boolean;
		mintRecoveryCode?: boolean;
	}>(event);
	if (typeof body.id !== 'number') return json({ error: 'id is required' }, { status: 400 });

	if (body.mintRecoveryCode === true) {
		const target = getUser(body.id);
		if (!target) return json({ error: 'No such user.' }, { status: 404 });
		// Gate exactly on the shape a credential-less, passwordless restored
		// account has. An admin account is refused outright — minting it a login
		// path outside the normal credential flow would be a privilege-adjacent
		// shortcut, same reasoning as the removed reclaim path never covering
		// admins (cairn-cpb5).
		if (target.isAdmin)
			return json(
				{ error: 'Admin accounts cannot be issued a recovery code this way.' },
				{ status: 400 }
			);
		if (target.disabled)
			return json(
				{ error: 'Enable the account before minting it a recovery code.' },
				{ status: 400 }
			);
		if (!hasNoCredentials(body.id) || hasPassword(body.id))
			return json(
				{
					error:
						'This account already has a passkey or a password — it does not need a recovery code.'
				},
				{ status: 400 }
			);

		const code = mintAdminRecoveryCode(body.id);
		log.warn({ actorId: admin.id, targetId: body.id }, 'admin minted a recovery code');
		recordActivity({
			type: 'account_recovery',
			level: 'warn',
			userId: body.id,
			message: `${admin.displayName || admin.email} minted a recovery code for this account (restored from a backup).`
		});
		// Fan out to every admin, mirroring admin_user_disabled/admin_restore —
		// minting a login path for someone else's account is exactly the kind of
		// action other admins on a multi-admin instance should see happen. The
		// plaintext code itself never leaves this response (detail carries no
		// secrets, same rule as everywhere else notify() is called).
		notify({
			type: 'admin_recovery_code_minted',
			userId: null,
			level: 'warn',
			title: 'Recovery code minted',
			body: `${admin.displayName || admin.email} minted a recovery code for ${target.email} (a restored account).`,
			detail: { byUserId: admin.id, targetUserId: body.id },
			link: `/admin/users/${body.id}`
		});
		return json({ code });
	}

	// Match the DELETE self-guard: an admin must not be able to lock themselves
	// out (self-disable) or strip their own admin rights (self-demote). The UI
	// hides these controls, but the endpoint was reachable by scripting directly.
	if (body.id === admin.id && body.disabled === true)
		return json({ error: 'You cannot disable your own account.' }, { status: 400 });
	if (body.id === admin.id && body.isAdmin === false)
		return json({ error: 'You cannot remove your own admin access.' }, { status: 400 });

	try {
		if (typeof body.disabled === 'boolean') setUserDisabled(body.id, body.disabled);
		if (typeof body.isAdmin === 'boolean') setUserAdmin(body.id, body.isAdmin);
	} catch (e) {
		if (e instanceof AuthError) return json({ error: e.message, code: e.code }, { status: 400 });
		throw e;
	}
	return json({ users: listUsers() });
};

/** DELETE { id } */
export const DELETE: RequestHandler = async (event) => {
	const admin = requireAdmin(event);
	const body = await readJson<{ id?: number }>(event);
	if (typeof body.id !== 'number') return json({ error: 'id is required' }, { status: 400 });
	if (body.id === admin.id)
		return json({ error: 'You cannot delete your own account.' }, { status: 400 });

	try {
		deleteUser(body.id);
	} catch (e) {
		if (e instanceof AuthError) return json({ error: e.message, code: e.code }, { status: 400 });
		throw e;
	}
	return json({ ok: true });
};
