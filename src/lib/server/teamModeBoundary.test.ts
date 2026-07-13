// cairn-8nk5 — assertTeamMode/requireTeamMode (api.ts:128-137) is the
// solo-vs-team authorization boundary that 404-gates every multi-user
// MANAGEMENT surface: admin users/invites, contacts, and multisig-share
// creation/editing. Before this file it had exactly one assertion anywhere
// in the suite (api.test.ts's "assertTeamMode: 404 ... fresh test DB defaults
// to solo") — nothing exercised the team-mode ALLOW path, and requireTeamMode
// (the /api-route variant that also requires sign-in) had zero coverage at
// all. This file closes both gaps at the function seam, per the bead's own
// prescribed fix ("add test with solo instanceMode asserting 404, team mode
// asserting pass-through").

import { describe, it, expect, beforeEach } from 'vitest';
import { isHttpError } from '@sveltejs/kit';
import type { RequestEvent } from '@sveltejs/kit';
import { db } from './db';
import { assertTeamMode, requireTeamMode } from './api';
import { setSetting } from './settings';

function wipe(): void {
	db.exec('DELETE FROM sessions; DELETE FROM users; DELETE FROM settings;');
}

beforeEach(wipe);

/** Minimal RequestEvent stand-in — mirrors api.test.ts's makeEvent(). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeEvent(overrides: Record<string, unknown> = {}): any {
	return {
		request: new Request('http://localhost/api/x'),
		url: new URL('http://localhost/api/x'),
		locals: { user: null, flags: {} },
		getClientAddress: () => '127.0.0.1',
		...overrides
	};
}

const SIGNED_IN_USER = { id: 1, email: 'a@x.com', displayName: 'A', isAdmin: false };

function expectDualFieldThrow(fn: () => unknown, status: number, message: string): void {
	let caught: unknown;
	try {
		fn();
	} catch (e) {
		caught = e;
	}
	expect(isHttpError(caught)).toBe(true);
	const err = caught as { status: number; body: { message?: string; error?: string } };
	expect(err.status).toBe(status);
	expect(err.body).toEqual({ message, error: message });
}

describe('assertTeamMode (api.ts:128) — the doc-block-declared behavior for admin users/invites, contacts, multisig-share pages', () => {
	it('solo mode (the fresh-DB default): throws 404 "Not found"', () => {
		expectDualFieldThrow(() => assertTeamMode(), 404, 'Not found');
	});

	it('solo mode (explicitly set, not just defaulted): also 404s', () => {
		setSetting('instance_mode', 'solo');
		expectDualFieldThrow(() => assertTeamMode(), 404, 'Not found');
	});

	it('team mode: passes through with no throw', () => {
		setSetting('instance_mode', 'team');
		expect(() => assertTeamMode()).not.toThrow();
		expect(assertTeamMode()).toBeUndefined();
	});

	it('toggling instanceMode is read live, not cached — team then back to solo re-blocks immediately', () => {
		setSetting('instance_mode', 'team');
		expect(() => assertTeamMode()).not.toThrow();
		setSetting('instance_mode', 'solo');
		expectDualFieldThrow(() => assertTeamMode(), 404, 'Not found');
	});
});

describe('requireTeamMode (api.ts:133) — the /api-route variant used by contacts + multisig-share endpoints', () => {
	it('signed out + solo mode: 401 "Authentication required" (requireUser runs first, never reveals the team-mode gate to an anonymous caller)', () => {
		expectDualFieldThrow(() => requireTeamMode(makeEvent()), 401, 'Authentication required');
	});

	it('signed in + solo mode: 404 "Not found" — sign-in alone is not enough on a solo instance', () => {
		const event = makeEvent({ locals: { user: SIGNED_IN_USER, flags: {} } });
		expectDualFieldThrow(() => requireTeamMode(event), 404, 'Not found');
	});

	it('signed in + team mode: returns the SessionUser, no throw', () => {
		setSetting('instance_mode', 'team');
		const event = makeEvent({ locals: { user: SIGNED_IN_USER, flags: {} } });
		expect(requireTeamMode(event)).toEqual(SIGNED_IN_USER);
	});

	it('signed out + team mode: still 401 — team mode alone does not bypass authentication', () => {
		setSetting('instance_mode', 'team');
		expectDualFieldThrow(() => requireTeamMode(makeEvent()), 401, 'Authentication required');
	});
});
