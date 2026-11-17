import { NextResponse } from 'next/server';
import { generateAuthenticationOptions } from '@simplewebauthn/server';
import { authenticatorDB, userDB } from '../../../../lib/db';
import { parseUsername, readJsonObject, relyingParty } from '../../../../lib/auth';
import { withChallenge } from '../../../../lib/auth-server';

export async function POST(request: Request) {
  const body = await readJsonObject(request);
  const username = parseUsername(body?.username);
  if (!username) {
    return NextResponse.json({ error: 'Enter a username of 1 to 64 characters.' }, { status: 400 });
  }
  const user = userDB.findByUsername(username);
  const credentials = user ? authenticatorDB.findAllByUser(user.id) : [];
  if (credentials.length === 0) {
    return NextResponse.json({ error: 'No passkey found for that username.' }, { status: 404 });
  }
  const options = await generateAuthenticationOptions({
    rpID: relyingParty().rpID,
    userVerification: 'required',
    allowCredentials: credentials.map(credential => ({ id: credential.credential_id })),
  });
  return withChallenge(NextResponse.json(options), 'login', username, 'authentication', options.challenge);
}
