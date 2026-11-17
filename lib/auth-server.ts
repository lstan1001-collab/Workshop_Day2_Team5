import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { challengeStore, type ChallengePurpose } from './db';
import { createSessionToken, SESSION_COOKIE, sessionCookieOptions } from './auth';

export const CHALLENGE_COOKIE = 'auth_challenge';
const CHALLENGE_TTL_SECONDS = 5 * 60;
const REQUEST_ID = /^[0-9a-f-]{36}$/;

export type ChallengeKind = 'register' | 'login' | 'add-passkey';

// The challenge is keyed by a random request ID held in this browser's cookie,
// so a challenge issued to one browser cannot be redeemed by another.
export function withChallenge(
  response: NextResponse, kind: ChallengeKind, username: string,
  purpose: ChallengePurpose, challenge: string,
): NextResponse {
  const requestId = crypto.randomUUID();
  challengeStore.save(`${kind}:${requestId}`, username, purpose, challenge);
  response.cookies.set(CHALLENGE_COOKIE, requestId, {
    ...sessionCookieOptions,
    path: '/api/auth',
    maxAge: CHALLENGE_TTL_SECONDS,
  });
  return response;
}

export async function takeChallenge(
  kind: ChallengeKind, username: string, purpose: ChallengePurpose,
): Promise<string | null> {
  const requestId = (await cookies()).get(CHALLENGE_COOKIE)?.value;
  if (!requestId || !REQUEST_ID.test(requestId)) return null;
  return challengeStore.consume(`${kind}:${requestId}`, username, purpose)?.challenge ?? null;
}

export async function signedInResponse(user: { id: number; username: string }): Promise<NextResponse> {
  const token = await createSessionToken({ userId: user.id, username: user.username });
  const response = NextResponse.json({ userId: user.id, username: user.username });
  response.cookies.set(SESSION_COOKIE, token, sessionCookieOptions);
  return response;
}

export function isUniqueViolation(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'SQLITE_CONSTRAINT_UNIQUE';
}
