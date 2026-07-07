import { assertTeamMode } from '$lib/server/api';
import { listContacts } from '$lib/server/contacts';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	assertTeamMode();
	return { contacts: listContacts(locals.user!.id) };
};
