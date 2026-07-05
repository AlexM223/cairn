// WebAuthn (passkey) ceremony helpers built on @simplewebauthn/server.
//
// Relying-Party identity is derived from the request so a self-hosted instance
// "just works" on whatever hostname the operator serves it from — overridable
// with CAIRN_RP_ID / CAIRN_ORIGIN for reverse-proxy setups. WebAuthn requires a
// secure context, so this only works over HTTPS (or http://localhost in dev).
//
// The per-ceremony challenge is held in a short-lived httpOnly cookie between
// the `options` and `verify` requests. The challenge is not secret; httpOnly +
// single-use (cleared on verify) + the authenticator's signature are what make
// the ceremony safe.

import type { RequestEvent } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import {
	generateRegistrationOptions,
	verifyRegistrationResponse,
	generateAuthenticationOptions,
	verifyAuthenticationResponse
} from '@simplewebauthn/server';
import type {
	AuthenticatorTransportFuture,
	AuthenticationResponseJSON,
	PublicKeyCredentialCreationOptionsJSON,
	PublicKeyCredentialRequestOptionsJSON,
	RegistrationResponseJSON,
	VerifiedAuthenticationResponse,
	VerifiedRegistrationResponse,
	WebAuthnCredential
} from '@simplewebauthn/server';

const RP_NAME = 'Cairn';
const REG_COOKIE = 'cairn_wa_reg';
const AUTH_COOKIE = 'cairn_wa_auth';
const CEREMONY_TTL_S = 300; // 5 minutes to complete a ceremony

type Descriptor = { id: string; transports?: string[] };

/** RP identity for this request. rpID is the host (no scheme/port). */
export function getRp(event: RequestEvent): { rpID: string; rpName: string; origin: string } {
	const origin = env.CAIRN_ORIGIN ?? event.url.origin;
	const rpID = env.CAIRN_RP_ID ?? event.url.hostname;
	return { rpID, rpName: RP_NAME, origin };
}

/** Stable per-account user handle for the authenticator (keeps a user's passkeys grouped). */
function userHandle(email: string): Uint8Array<ArrayBuffer> {
	// Copy into a fresh ArrayBuffer-backed view (TextEncoder yields ArrayBufferLike).
	return new Uint8Array(new TextEncoder().encode(email.trim().toLowerCase()));
}

function toDescriptors(creds: Descriptor[]) {
	return creds.map((c) => ({
		id: c.id,
		transports: (c.transports ?? []) as AuthenticatorTransportFuture[]
	}));
}

// ---------------------------------------------------------------- ceremonies

export function buildRegistrationOptions(
	event: RequestEvent,
	opts: { email: string; displayName: string; exclude: Descriptor[] }
): Promise<PublicKeyCredentialCreationOptionsJSON> {
	const { rpID, rpName } = getRp(event);
	return generateRegistrationOptions({
		rpName,
		rpID,
		userName: opts.email,
		userID: userHandle(opts.email),
		userDisplayName: opts.displayName,
		attestationType: 'none',
		excludeCredentials: toDescriptors(opts.exclude),
		authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' }
	});
}

export function verifyRegistration(
	event: RequestEvent,
	response: RegistrationResponseJSON,
	expectedChallenge: string
): Promise<VerifiedRegistrationResponse> {
	const { rpID, origin } = getRp(event);
	return verifyRegistrationResponse({
		response,
		expectedChallenge,
		expectedOrigin: origin,
		expectedRPID: rpID,
		// Accept both biometric (UV) and possession-only security keys.
		requireUserVerification: false
	});
}

export function buildAuthenticationOptions(
	event: RequestEvent,
	allow: Descriptor[]
): Promise<PublicKeyCredentialRequestOptionsJSON> {
	const { rpID } = getRp(event);
	return generateAuthenticationOptions({
		rpID,
		allowCredentials: toDescriptors(allow),
		userVerification: 'preferred'
	});
}

export function verifyAuthentication(
	event: RequestEvent,
	response: AuthenticationResponseJSON,
	expectedChallenge: string,
	credential: WebAuthnCredential
): Promise<VerifiedAuthenticationResponse> {
	const { rpID, origin } = getRp(event);
	return verifyAuthenticationResponse({
		response,
		expectedChallenge,
		expectedOrigin: origin,
		expectedRPID: rpID,
		credential,
		requireUserVerification: false
	});
}

// ------------------------------------------------------------ challenge cookies

export interface RegChallenge {
	challenge: string;
	/** Signup context — a user does not exist yet. */
	email?: string;
	displayName?: string;
	inviteCode?: string;
	/** Add-passkey context — an existing user is registering another credential. */
	userId?: number;
}

export interface AuthChallenge {
	challenge: string;
	userId: number;
}

function cookieOpts(event: RequestEvent) {
	return {
		path: '/',
		httpOnly: true,
		sameSite: 'lax' as const,
		secure: event.url.protocol === 'https:',
		maxAge: CEREMONY_TTL_S
	};
}

export function setRegChallenge(event: RequestEvent, data: RegChallenge): void {
	event.cookies.set(REG_COOKIE, JSON.stringify(data), cookieOpts(event));
}

export function readRegChallenge(event: RequestEvent): RegChallenge | null {
	return parseCookie<RegChallenge>(event.cookies.get(REG_COOKIE));
}

export function clearRegChallenge(event: RequestEvent): void {
	event.cookies.delete(REG_COOKIE, { path: '/' });
}

export function setAuthChallenge(event: RequestEvent, data: AuthChallenge): void {
	event.cookies.set(AUTH_COOKIE, JSON.stringify(data), cookieOpts(event));
}

export function readAuthChallenge(event: RequestEvent): AuthChallenge | null {
	return parseCookie<AuthChallenge>(event.cookies.get(AUTH_COOKIE));
}

export function clearAuthChallenge(event: RequestEvent): void {
	event.cookies.delete(AUTH_COOKIE, { path: '/' });
}

function parseCookie<T>(raw: string | undefined): T | null {
	if (!raw) return null;
	try {
		return JSON.parse(raw) as T;
	} catch {
		return null;
	}
}
