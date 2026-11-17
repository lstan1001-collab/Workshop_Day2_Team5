import {
  browserSupportsWebAuthn,
  startAuthentication,
  startRegistration,
} from '@simplewebauthn/browser';

type RegistrationOptions = Parameters<typeof startRegistration>[0]['optionsJSON'];
type AuthenticationOptions = Parameters<typeof startAuthentication>[0]['optionsJSON'];

export interface AuthSession {
  userId: number;
  username: string;
}

class AuthRequestError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

async function request<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/api/auth/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'same-origin',
    cache: 'no-store',
    signal,
  });
  if (!response.ok) {
    let message = `Authentication request failed (${response.status}). Please try again.`;
    if (response.headers.get('content-type')?.includes('application/json')) {
      const payload: unknown = await response.json();
      if (payload && typeof payload === 'object' && 'error' in payload &&
          typeof payload.error === 'string') message = payload.error;
    }
    throw new AuthRequestError(message, response.status);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export async function getCurrentSession(signal?: AbortSignal): Promise<AuthSession | null> {
  let payload: unknown;
  try {
    payload = await request<unknown>('me', undefined, signal);
  } catch (error) {
    if (error instanceof AuthRequestError && error.status === 401) return null;
    throw error;
  }
  if (!payload || typeof payload !== 'object' ||
      !('userId' in payload) || typeof payload.userId !== 'number' || !Number.isInteger(payload.userId) ||
      !('username' in payload) || typeof payload.username !== 'string') {
    throw new Error('The server returned an invalid session response.');
  }
  return { userId: payload.userId, username: payload.username };
}

export async function authenticate(mode: 'login' | 'register', username: string): Promise<void> {
  if (!browserSupportsWebAuthn()) throw new Error("Your browser/device doesn't support passkeys.");
  if (mode === 'register') {
    const optionsJSON = await request<RegistrationOptions>('register-options', { username });
    const response = await startRegistration({ optionsJSON });
    await request('register-verify', { username, response });
  } else {
    const optionsJSON = await request<AuthenticationOptions>('login-options', { username });
    const response = await startAuthentication({ optionsJSON });
    await request('login-verify', { username, response });
  }
}

export async function addPasskey(): Promise<void> {
  if (!browserSupportsWebAuthn()) throw new Error("Your browser/device doesn't support passkeys.");
  const optionsJSON = await request<RegistrationOptions>('add-passkey-options', {});
  const response = await startRegistration({ optionsJSON });
  await request('add-passkey-verify', { response });
}

export async function logout(): Promise<void> {
  await request('logout', {});
}

export function authFailure(error: unknown): { cancelled: boolean; message: string } {
  const cause = error instanceof Error && error.cause instanceof Error ? error.cause : error;
  if (cause instanceof Error && cause.name === 'NotAllowedError') {
    return { cancelled: true, message: 'Passkey prompt cancelled or timed out. You can try again.' };
  }
  return {
    cancelled: false,
    message: error instanceof TypeError
      ? 'Could not connect to authentication. Check your connection and try again.'
      : error instanceof Error ? error.message : 'Authentication failed. Please try again.',
  };
}
