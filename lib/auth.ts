import { jwtVerify, SignJWT } from 'jose';

export const SESSION_COOKIE = 'session';

const SESSION_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;
const MIN_SECRET_LENGTH = 32;
const MAX_USERNAME_LENGTH = 64;

export interface SessionPayload {
  userId: number;
  username: string;
}

// Throws when unset so that signing fails closed instead of using a default key.
function authSecret(): Uint8Array {
  const secret = process.env.AUTH_SECRET;
  if (!secret || secret.length < MIN_SECRET_LENGTH) {
    throw new Error(`AUTH_SECRET must be set to at least ${MIN_SECRET_LENGTH} characters`);
  }
  return new TextEncoder().encode(secret);
}

export function relyingParty(): { rpID: string; origin: string } {
  return {
    rpID: process.env.WEBAUTHN_RP_ID ?? 'localhost',
    origin: process.env.WEBAUTHN_ORIGIN ?? 'http://localhost:3105',
  };
}

export const sessionCookieOptions = {
  httpOnly: true,
  sameSite: 'lax' as const,
  secure: process.env.NODE_ENV === 'production',
  path: '/',
  maxAge: SESSION_MAX_AGE_SECONDS,
};

export async function createSessionToken(session: SessionPayload): Promise<string> {
  return new SignJWT({ userId: session.userId, username: session.username })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(`${SESSION_MAX_AGE_SECONDS}s`)
    .sign(authSecret());
}

export async function verifySessionToken(token: string | undefined): Promise<SessionPayload | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, authSecret(), { algorithms: ['HS256'] });
    if (typeof payload.userId !== 'number' || typeof payload.username !== 'string') return null;
    return { userId: payload.userId, username: payload.username };
  } catch {
    return null;
  }
}

export function parseUsername(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const username = value.trim();
  return username.length >= 1 && username.length <= MAX_USERNAME_LENGTH ? username : null;
}

export async function readJsonObject(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await request.json();
    return body && typeof body === 'object' && !Array.isArray(body)
      ? body as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}
