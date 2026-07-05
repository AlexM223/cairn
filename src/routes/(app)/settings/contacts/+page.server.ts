import { listContacts } from '$lib/server/contacts';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	return { contacts: listContacts(locals.user!.id) };
};
