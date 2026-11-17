import { NextResponse } from 'next/server';
import { verifyRegistrationResponse, type RegistrationResponseJSON } from '@simplewebauthn/server';
import { registrationDB, userDB } from '../../../../lib/db';
import { parseUsername, readJsonObject, relyingParty } from '../../../../lib/auth';
import { isUniqueViolation, signedInResponse, takeChallenge } from '../../../../lib/auth-server';

const TAKEN = 'That username or passkey is already registered.';

export async function POST(request: Request) {
  const body = await readJsonObject(request);
  const username = parseUsername(body?.username);
  const response = body?.response;
  if (!username || !response || typeof response !== 'object') {
    return NextResponse.json({ error: 'Username and passkey response are required.' }, { status: 400 });
  }
  const expectedChallenge = await takeChallenge('register', username, 'registration');
  if (!expectedChallenge) {
    return NextResponse.json({ error: 'Registration expired. Start again.' }, { status: 400 });
  }
  if (userDB.findByUsername(username)) {
    return NextResponse.json({ error: TAKEN }, { status: 409 });
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
    return NextResponse.json({ error: 'Passkey registration could not be verified.' }, { status: 400 });
  }

  const { credential } = verification.registrationInfo;
  try {
    const { user } = registrationDB.create(username, {
      credential_id: credential.id,
      credential_public_key: credential.publicKey,
      counter: credential.counter,
    });
    return signedInResponse(user);
  } catch (error) {
    if (isUniqueViolation(error)) {
      return NextResponse.json({ error: TAKEN }, { status: 409 });
    }
    throw error;
  }
}
