import { fail } from '@sveltejs/kit';
import { listUsers, resetUserPassword, setUserAdmin, setUserDisabled } from '$lib/server/admin';
import { AuthError } from '$lib/server/auth';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async () => {
	return { users: listUsers() };
};

function userAction(fn: (id: number) => void) {
	return async ({ request }: { request: Request }) => {
		const form = await request.formData();
		const id = Number(form.get('id'));
		if (!Number.isInteger(id)) return fail(400, { error: 'Invalid user id' });
		try {
			fn(id);
		} catch (e) {
			if (e instanceof AuthError) return fail(400, { error: e.message });
			throw e;
		}
		return { ok: true };
	};
}

export const actions: Actions = {
	disable: userAction((id) => setUserDisabled(id, true)),
	enable: userAction((id) => setUserDisabled(id, false)),
	promote: userAction((id) => setUserAdmin(id, true)),
	demote: userAction((id) => setUserAdmin(id, false)),

	resetPassword: async ({ request, locals }) => {
		const form = await request.formData();
		const id = Number(form.get('id'));
		if (!Number.isInteger(id)) return fail(400, { error: 'Invalid user id' });
		// Admins change their own password in Settings — this action is for
		// recovering OTHER accounts.
		if (locals.user && locals.user.id === id)
			return fail(400, { error: 'Use Settings to change your own password.' });

		try {
			const { tempPassword } = resetUserPassword(id);
			const user = listUsers().find((u) => u.id === id);
			return { tempPassword, tempPasswordFor: user?.email ?? `user #${id}` };
		} catch (e) {
			if (e instanceof AuthError) return fail(400, { error: e.message });
			throw e;
		}
	}
};
