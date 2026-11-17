import { NextResponse } from 'next/server';
import { generateRegistrationOptions } from '@simplewebauthn/server';
import { userDB } from '../../../../lib/db';
import { parseUsername, readJsonObject, relyingParty } from '../../../../lib/auth';
import { withChallenge } from '../../../../lib/auth-server';

export async function POST(request: Request) {
  const body = await readJsonObject(request);
  const username = parseUsername(body?.username);
  if (!username) {
    return NextResponse.json({ error: 'Enter a username of 1 to 64 characters.' }, { status: 400 });
  }
  if (userDB.findByUsername(username)) {
    return NextResponse.json({ error: 'That username is already taken.' }, { status: 409 });
  }
  const options = await generateRegistrationOptions({
    rpName: 'Todo App',
    rpID: relyingParty().rpID,
    userName: username,
    userID: new TextEncoder().encode(crypto.randomUUID()),
    attestationType: 'none',
    authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
  });
  return withChallenge(NextResponse.json(options), 'register', username, 'registration', options.challenge);
}
