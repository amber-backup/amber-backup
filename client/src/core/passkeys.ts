import {
  startRegistration,
  startAuthentication,
  browserSupportsWebAuthn,
} from '@simplewebauthn/browser';
import { api, type User } from './api';

type RegistrationOptions = Parameters<typeof startRegistration>[0]['optionsJSON'];
type AuthenticationOptions = Parameters<typeof startAuthentication>[0]['optionsJSON'];

export interface Passkey {
  id: string;
  name: string;
  device_type: string | null;
  backed_up: boolean;
  created_at: string;
  last_used_at: string | null;
}

/** Whether this browser can perform WebAuthn ceremonies at all. */
export const passkeysSupported = (): boolean => browserSupportsWebAuthn();

/**
 * Registers a new passkey for the signed-in user: fetch options, run the
 * browser ceremony (prompts the authenticator), and hand the attestation back
 * to the server for verification + storage.
 */
export async function registerPasskey(name: string): Promise<void> {
  const optionsJSON = await api.post<RegistrationOptions>(
    '/auth/passkeys/register/options',
  );
  const response = await startRegistration({ optionsJSON });
  await api.post('/auth/passkeys/register/verify', { response, name });
}

/**
 * Usernameless passkey login: the authenticator picks the account, so no email
 * is entered. Returns the authenticated user on success.
 */
export async function authenticatePasskey(): Promise<User> {
  const optionsJSON = await api.post<AuthenticationOptions>(
    '/auth/passkeys/login/options',
  );
  const response = await startAuthentication({ optionsJSON });
  const res = await api.post<{ user: User }>('/auth/passkeys/login/verify', {
    response,
  });
  return res.user;
}
