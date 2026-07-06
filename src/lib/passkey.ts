// Client-side passkey (WebAuthn) helpers: the three ceremonies the UI needs,
// each a fetch → browser prompt → fetch round-trip, with friendly errors.
// No server imports here — this runs in the browser.

import {
	startRegistration,
	startAuthentication,
	browserSupportsWebAuthn,
	WebAuthnError
} from '@simplewebauthn/browser';
import type { CredentialInfo, SessionUser } from '$lib/types';

export { browserSupportsWebAuthn };

async function request<T = unknown>(url: string, body: unknown): Promise<T> {
	const res = await fetch(url, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(body ?? {})
	});
	const data = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
	if (!res.ok) throw new Error(data?.error || `Request failed (${res.status}).`);
	return data as T;
}

/** Turn a browser WebAuthn failure into something a person can read. */
function friendly(e: unknown): Error {
	if (e instanceof WebAuthnError) {
		if (e.name === 'NotAllowedError' || e.code === 'ERROR_CEREMONY_ABORTED')
			return new Error('Passkey prompt was dismissed. Try again when ready.');
		if (e.code === 'ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED')
			return new Error('That device already has a passkey for this account.');
		return new Error(e.message || 'Your device could not complete the passkey step.');
	}
	if (e instanceof Error) return e;
	return new Error('Something went wrong with the passkey step.');
}

/** Best-effort human label for a new passkey, from the browser/platform. */
export function guessPasskeyName(): string {
	if (typeof navigator === 'undefined') return 'Passkey';
	const ua = navigator.userAgent;
	const os = /Windows/.test(ua)
		? 'Windows'
		: /Mac/.test(ua)
			? 'Mac'
			: /iPhone|iPad/.test(ua)
				? 'iOS'
				: /Android/.test(ua)
					? 'Android'
					: /Linux/.test(ua)
						? 'Linux'
						: '';
	const browser = /Edg\//.test(ua)
		? 'Edge'
		: /Chrome\//.test(ua)
			? 'Chrome'
			: /Firefox\//.test(ua)
				? 'Firefox'
				: /Safari\//.test(ua)
					? 'Safari'
					: '';
	return [browser, os].filter(Boolean).join(' on ') || 'Passkey';
}

/** Signup: create an account and its first passkey. Returns the new user. */
export async function signUpWithPasskey(input: {
	email: string;
	displayName: string;
	inviteCode?: string;
}): Promise<SessionUser> {
	const options = await request<Parameters<typeof startRegistration>[0]['optionsJSON']>(
		'/api/auth/register/options',
		input
	);
	let attResp;
	try {
		attResp = await startRegistration({ optionsJSON: options });
	} catch (e) {
		throw friendly(e);
	}
	const { user } = await request<{ user: SessionUser }>('/api/auth/register/verify', {
		response: attResp,
		name: guessPasskeyName()
	});
	return user;
}

/** Login: prove a passkey for the given email. Returns the signed-in user. */
export async function signInWithPasskey(email: string): Promise<SessionUser> {
	const options = await request<Parameters<typeof startAuthentication>[0]['optionsJSON']>(
		'/api/auth/login/options',
		{ email }
	);
	let asseResp;
	try {
		asseResp = await startAuthentication({ optionsJSON: options });
	} catch (e) {
		throw friendly(e);
	}
	const { user } = await request<{ user: SessionUser }>('/api/auth/login/verify', {
		response: asseResp
	});
	return user;
}

/** Settings: add another passkey to the signed-in account. Returns the new list. */
export async function addPasskey(name?: string): Promise<CredentialInfo[]> {
	const options = await request<Parameters<typeof startRegistration>[0]['optionsJSON']>(
		'/api/auth/passkeys/options',
		{}
	);
	let attResp;
	try {
		attResp = await startRegistration({ optionsJSON: options });
	} catch (e) {
		throw friendly(e);
	}
	const { passkeys } = await request<{ passkeys: CredentialInfo[] }>('/api/auth/passkeys', {
		response: attResp,
		name: name || guessPasskeyName()
	});
	return passkeys;
}
