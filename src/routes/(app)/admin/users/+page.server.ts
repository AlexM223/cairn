import { fail } from '@sveltejs/kit';
import { listUsers, setUserAdmin, setUserDisabled } from '$lib/server/admin';
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
	demote: userAction((id) => setUserAdmin(id, false))
};
