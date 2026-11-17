import { cookies } from 'next/headers';
import { errors, jwtVerify, SignJWT } from 'jose';
import type { User } from '@/lib/db';

export interface Session {
  userId: number;
  username: string;
}

export const SESSION_COOKIE = 'session';
const SESSION_SECONDS = 7 * 24 * 60 * 60;

function sessionKey(): Uint8Array {
  const secret = process.env.JWT_SECRET;
  if (!secret || new TextEncoder().encode(secret).length < 32) {
    throw new Error('JWT_SECRET must contain at least 32 bytes');
  }
  return new TextEncoder().encode(secret);
}

export async function signSession(user: Pick<User, 'id' | 'username'>): Promise<string> {
  return new SignJWT({ userId: user.id, username: user.username })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setIssuer('todo-app')
    .setAudience('todo-app')
    .setExpirationTime(`${SESSION_SECONDS}s`)
    .sign(sessionKey());
}

export async function verifySession(token: string | undefined): Promise<Session | null> {
  if (!token) return null;
  const key = sessionKey();
  try {
    const { payload } = await jwtVerify(token, key, {
      algorithms: ['HS256'],
      issuer: 'todo-app',
      audience: 'todo-app',
      requiredClaims: ['exp', 'iat'],
    });
    if (
      typeof payload.userId !== 'number' || !Number.isSafeInteger(payload.userId) ||
      payload.userId <= 0 || typeof payload.username !== 'string' || !payload.username
    ) return null;
    return { userId: payload.userId, username: payload.username };
  } catch (error) {
    if (error instanceof errors.JOSEError) return null;
    throw error;
  }
}

export async function createSession(user: User): Promise<void> {
  (await cookies()).set(SESSION_COOKIE, await signSession(user), {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_SECONDS,
  });
}

export async function getSession(): Promise<Session | null> {
  return verifySession((await cookies()).get(SESSION_COOKIE)?.value);
}

export async function deleteSession(): Promise<void> {
  (await cookies()).delete(SESSION_COOKIE);
}
