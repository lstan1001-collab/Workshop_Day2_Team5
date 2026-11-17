import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { generateRegistrationOptions } from '@simplewebauthn/server';
import { authenticatorDB, userDB } from '../../../../lib/db';
import { relyingParty, SESSION_COOKIE, verifySessionToken } from '../../../../lib/auth';
import { withChallenge } from '../../../../lib/auth-server';

export async function POST() {
  const session = await verifySessionToken((await cookies()).get(SESSION_COOKIE)?.value);
  const user = session ? userDB.findById(session.userId) : undefined;
  if (!user) {
    return NextResponse.json({ error: 'Sign in first.' }, { status: 401 });
  }
  const options = await generateRegistrationOptions({
    rpName: 'Todo App',
    rpID: relyingParty().rpID,
    userName: user.username,
    userID: new TextEncoder().encode(String(user.id)),
    attestationType: 'none',
    excludeCredentials: authenticatorDB.findAllByUser(user.id).map(credential => ({
      id: credential.credential_id,
    })),
    authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
  });
  return withChallenge(NextResponse.json(options), 'add-passkey', user.username, 'registration', options.challenge);
}
