import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { verifyRegistrationResponse, type RegistrationResponseJSON } from '@simplewebauthn/server';
import { authenticatorDB, userDB } from '../../../../lib/db';
import { readJsonObject, relyingParty, SESSION_COOKIE, verifySessionToken } from '../../../../lib/auth';
import { isUniqueViolation, takeChallenge } from '../../../../lib/auth-server';

export async function POST(request: Request) {
  const session = await verifySessionToken((await cookies()).get(SESSION_COOKIE)?.value);
  const user = session ? userDB.findById(session.userId) : undefined;
  if (!user) {
    return NextResponse.json({ error: 'Sign in first.' }, { status: 401 });
  }
  const body = await readJsonObject(request);
  const response = body?.response;
  if (!response || typeof response !== 'object') {
    return NextResponse.json({ error: 'Passkey response is required.' }, { status: 400 });
  }
  const expectedChallenge = await takeChallenge('add-passkey', user.username, 'registration');
  if (!expectedChallenge) {
    return NextResponse.json({ error: 'Passkey setup expired. Start again.' }, { status: 400 });
  }

  const { rpID, origin } = relyingParty();
  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response: response as RegistrationResponseJSON,
      expectedChallenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      requireUserVerification: true,
    });
  } catch {
    verification = null;
  }
  if (!verification?.verified) {
    return NextResponse.json({ error: 'Passkey could not be verified.' }, { status: 400 });
  }

  const { credential } = verification.registrationInfo;
  try {
    authenticatorDB.create(user.id, {
      credential_id: credential.id,
      credential_public_key: credential.publicKey,
      counter: credential.counter,
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      return NextResponse.json({ error: 'This passkey is already registered.' }, { status: 409 });
    }
    throw error;
  }
  return new NextResponse(null, { status: 204 });
}
