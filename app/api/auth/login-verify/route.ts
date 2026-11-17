import { NextResponse } from 'next/server';
import { verifyAuthenticationResponse, type AuthenticationResponseJSON } from '@simplewebauthn/server';
import { authenticatorDB, userDB } from '../../../../lib/db';
import { parseUsername, readJsonObject, relyingParty } from '../../../../lib/auth';
import { signedInResponse, takeChallenge } from '../../../../lib/auth-server';

const FAILED = 'Sign-in failed. Check your passkey and try again.';

export async function POST(request: Request) {
  const body = await readJsonObject(request);
  const username = parseUsername(body?.username);
  const response = body?.response;
  if (!username || !response || typeof response !== 'object' || typeof (response as { id?: unknown }).id !== 'string') {
    return NextResponse.json({ error: 'Username and passkey response are required.' }, { status: 400 });
  }
  const expectedChallenge = await takeChallenge('login', username, 'authentication');
  if (!expectedChallenge) {
    return NextResponse.json({ error: 'Sign-in expired. Start again.' }, { status: 400 });
  }
  const user = userDB.findByUsername(username);
  if (!user) {
    return NextResponse.json({ error: FAILED }, { status: 401 });
  }
  const stored = authenticatorDB.findByCredentialIdForUser((response as { id: string }).id, user.id);
  if (!stored) {
    return NextResponse.json({ error: FAILED }, { status: 401 });
  }

  const { rpID, origin } = relyingParty();
  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response: response as AuthenticationResponseJSON,
      expectedChallenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      credential: {
        id: stored.credential_id,
        publicKey: new Uint8Array(stored.credential_public_key),
        counter: stored.counter,
      },
      requireUserVerification: true,
    });
  } catch {
    verification = null;
  }
  if (!verification?.verified) {
    return NextResponse.json({ error: FAILED }, { status: 401 });
  }
  try {
    authenticatorDB.updateCounter(stored.id, verification.authenticationInfo.newCounter);
  } catch {
    return NextResponse.json({ error: FAILED }, { status: 401 });
  }
  return signedInResponse(user);
}
