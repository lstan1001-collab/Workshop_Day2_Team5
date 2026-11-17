import { randomBytes } from 'node:crypto';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import {
  generateAuthenticationOptions, generateRegistrationOptions,
  verifyAuthenticationResponse, verifyRegistrationResponse,
} from '@simplewebauthn/server';
import { isoBase64URL } from '@simplewebauthn/server/helpers';
import { z } from 'zod';
import { ApiError, apiError, readJSON } from '@/lib/api';
import { createSession, getSession } from '@/lib/auth';
import { authenticatorDB, db, userDB } from '@/lib/db';

const usernameSchema = z.string().trim().min(1, 'Username is required').max(64);
const base64url = z.string().min(1).regex(/^[A-Za-z0-9_-]+$/);
const credentialSchema = z.object({
  id: base64url,
  rawId: base64url,
  type: z.literal('public-key'),
  clientExtensionResults: z.object({}),
  authenticatorAttachment: z.enum(['platform', 'cross-platform']).optional(),
});
const registrationSchema = credentialSchema.extend({
  response: z.object({
    clientDataJSON: base64url,
    attestationObject: base64url,
    transports: z.array(z.enum(['ble', 'cable', 'hybrid', 'internal', 'nfc', 'smart-card', 'usb'])).optional(),
  }),
});
const authenticationSchema = credentialSchema.extend({
  response: z.object({
    clientDataJSON: base64url,
    authenticatorData: base64url,
    signature: base64url,
    userHandle: z.string().optional(),
  }),
});

type Ceremony = { username: string; challenge: string; kind: 'register' | 'login' | 'add-passkey'; expires: number };
const CHALLENGE_COOKIE = 'webauthn-challenge';

function relyingParty() {
  const production = process.env.NODE_ENV === 'production';
  const origin = process.env.RP_ORIGIN ?? (production ? undefined : 'http://localhost:3000');
  const rpID = process.env.RP_ID ?? (production ? undefined : 'localhost');
  if (!origin || !rpID) throw new Error('RP_ORIGIN and RP_ID are required in production');
  return { origin, rpID, rpName: process.env.RP_NAME ?? 'Todo App' };
}

function checkOrigin(request: Request): void {
  const origin = request.headers.get('origin');
  if (origin && origin !== relyingParty().origin) throw new ApiError('Invalid origin', 403);
}

async function saveChallenge(ceremony: Omit<Ceremony, 'expires'>): Promise<void> {
  const jar = await cookies();
  const previous = jar.get(CHALLENGE_COOKIE)?.value;
  const id = randomBytes(32).toString('base64url');
  const now = Date.now();
  db.transaction(() => {
    db.prepare('DELETE FROM auth_challenges WHERE expires <= ?').run(now);
    if (previous) db.prepare('DELETE FROM auth_challenges WHERE id = ?').run(previous);
    const { count } = db.prepare('SELECT COUNT(*) AS count FROM auth_challenges').get() as { count: number };
    if (count >= 10_000) throw new ApiError('Too many authentication attempts', 429);
    db.prepare('INSERT INTO auth_challenges (id, username, kind, challenge, expires) VALUES (?, ?, ?, ?, ?)')
      .run(id, ceremony.username, ceremony.kind, ceremony.challenge, now + 300_000);
  }).immediate();
  jar.set(CHALLENGE_COOKIE, id, {
    httpOnly: true, secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict', path: '/api/auth', maxAge: 300,
  });
}

async function consumeChallenge(username: string, kind: Ceremony['kind']): Promise<string> {
  const jar = await cookies();
  const id = jar.get(CHALLENGE_COOKIE)?.value;
  const entry = id
    ? db.prepare('DELETE FROM auth_challenges WHERE id = ? RETURNING username, kind, challenge, expires')
      .get(id) as Ceremony | undefined
    : undefined;
  jar.set(CHALLENGE_COOKIE, '', { path: '/api/auth', maxAge: 0 });
  if (!entry || entry.kind !== kind || entry.username !== username || entry.expires <= Date.now()) {
    throw new ApiError('Authentication challenge expired or invalid', 401);
  }
  return entry.challenge;
}

export async function registerOptions(request: Request) {
  try {
    checkOrigin(request);
    const { username } = z.object({ username: usernameSchema }).parse(await readJSON(request));
    if (userDB.findByUsername(username)) throw new ApiError('Username already taken', 409);
    const { rpID, rpName } = relyingParty();
    const options = await generateRegistrationOptions({
      rpID, rpName, userName: username, attestationType: 'none',
      authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
    });
    await saveChallenge({ username, challenge: options.challenge, kind: 'register' });
    return NextResponse.json(options);
  } catch (error) { return apiError(error); }
}

export async function registerVerify(request: Request) {
  try {
    checkOrigin(request);
    const { username, response } = z.object({
      username: usernameSchema, response: registrationSchema,
    }).parse(await readJSON(request));
    const challenge = await consumeChallenge(username, 'register');
    const { origin, rpID } = relyingParty();
    const result = await verifyRegistrationResponse({
      response, expectedChallenge: challenge, expectedOrigin: origin,
      expectedRPID: rpID, requireUserVerification: true,
    }).catch(() => { throw new ApiError('Passkey verification failed', 401); });
    if (!result.verified) throw new ApiError('Passkey verification failed', 401);
    const user = db.transaction(() => {
      if (userDB.findByUsername(username)) throw new ApiError('Username already taken', 409);
      const created = userDB.create(username);
      const { credential } = result.registrationInfo;
      authenticatorDB.create({
        user_id: created.id,
        credential_id: isoBase64URL.fromBuffer(isoBase64URL.toBuffer(credential.id)),
        credential_public_key: Buffer.from(credential.publicKey),
        counter: credential.counter ?? 0,
      });
      return created;
    })();
    await createSession(user);
    return NextResponse.json({ success: true });
  } catch (error) { return apiError(error); }
}

export async function loginOptions(request: Request) {
  try {
    checkOrigin(request);
    const { username } = z.object({ username: usernameSchema }).parse(await readJSON(request));
    const user = userDB.findByUsername(username);
    if (!user) throw new ApiError('User not found', 404);
    const authenticators = authenticatorDB.findByUserId(user.id);
    if (!authenticators.length) throw new ApiError('No passkeys registered', 401);
    const options = await generateAuthenticationOptions({
      rpID: relyingParty().rpID, userVerification: 'required',
      allowCredentials: authenticators.map(({ credential_id }) => ({ id: credential_id })),
    });
    await saveChallenge({ username, challenge: options.challenge, kind: 'login' });
    return NextResponse.json(options);
  } catch (error) { return apiError(error); }
}

export async function loginVerify(request: Request) {
  try {
    checkOrigin(request);
    const { username, response } = z.object({
      username: usernameSchema, response: authenticationSchema,
    }).parse(await readJSON(request));
    const challenge = await consumeChallenge(username, 'login');
    const user = userDB.findByUsername(username);
    const authenticator = authenticatorDB.findByCredentialId(response.id);
    if (!user || !authenticator || authenticator.user_id !== user.id) {
      throw new ApiError('Authenticator not recognized', 401);
    }
    const { origin, rpID } = relyingParty();
    const result = await verifyAuthenticationResponse({
      response, expectedChallenge: challenge, expectedOrigin: origin, expectedRPID: rpID,
      credential: {
        id: authenticator.credential_id,
        publicKey: new Uint8Array(authenticator.credential_public_key),
        counter: authenticator.counter ?? 0,
      },
      requireUserVerification: true,
    }).catch(() => { throw new ApiError('Passkey verification failed', 401); });
    if (!result.verified) throw new ApiError('Passkey verification failed', 401);
    db.transaction(() => {
      const current = authenticatorDB.findByCredentialId(response.id);
      const next = result.authenticationInfo.newCounter ?? 0;
      if (!current || (next !== 0 || (current.counter ?? 0) !== 0) && next <= (current.counter ?? 0)) {
        throw new ApiError('Passkey counter did not advance', 401);
      }
      authenticatorDB.updateCounter(authenticator.id, next);
    })();
    await createSession(user);
    return NextResponse.json({ success: true });
  } catch (error) { return apiError(error); }
}

async function authenticatedUser() {
  const session = await getSession();
  const user = session ? userDB.findById(session.userId) : null;
  if (!user || user.username !== session?.username) throw new ApiError('Not authenticated', 401);
  return user;
}

export async function addPasskeyOptions(request: Request) {
  try {
    checkOrigin(request);
    const user = await authenticatedUser();
    const { rpID, rpName } = relyingParty();
    const options = await generateRegistrationOptions({
      rpID, rpName, userName: user.username,
      userID: new TextEncoder().encode(String(user.id)),
      attestationType: 'none',
      excludeCredentials: authenticatorDB.findByUserId(user.id).map(({ credential_id }) => ({ id: credential_id })),
      authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
    });
    await saveChallenge({ username: user.username, challenge: options.challenge, kind: 'add-passkey' });
    return NextResponse.json(options);
  } catch (error) { return apiError(error); }
}

export async function addPasskeyVerify(request: Request) {
  try {
    checkOrigin(request);
    const user = await authenticatedUser();
    const { response } = z.object({ response: registrationSchema }).parse(await readJSON(request));
    const challenge = await consumeChallenge(user.username, 'add-passkey');
    const { origin, rpID } = relyingParty();
    const result = await verifyRegistrationResponse({
      response, expectedChallenge: challenge, expectedOrigin: origin,
      expectedRPID: rpID, requireUserVerification: true,
    }).catch(() => { throw new ApiError('Passkey verification failed', 401); });
    if (!result.verified) throw new ApiError('Passkey verification failed', 401);
    const { credential } = result.registrationInfo;
    try {
      authenticatorDB.create({
        user_id: user.id,
        credential_id: isoBase64URL.fromBuffer(isoBase64URL.toBuffer(credential.id)),
        credential_public_key: Buffer.from(credential.publicKey),
        counter: credential.counter ?? 0,
      });
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
        throw new ApiError('This passkey is already registered', 409);
      }
      throw error;
    }
    return NextResponse.json({ success: true });
  } catch (error) { return apiError(error); }
}
