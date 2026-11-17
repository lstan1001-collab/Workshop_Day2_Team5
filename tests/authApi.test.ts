import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { isoCBOR } from '@simplewebauthn/server/helpers';

const state = await vi.hoisted(async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'todo-auth-test-'));
  const previous = process.cwd();
  process.chdir(directory);
  return { directory, previous, jar: new Map<string, string>() };
});

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => {
      const value = state.jar.get(name);
      return value ? { value } : undefined;
    },
    set: (name: string, value: string) => { state.jar.set(name, value); },
    delete: (name: string) => { state.jar.delete(name); },
  }),
}));

const {
  registerOptions, registerVerify, loginOptions, loginVerify, addPasskeyOptions, addPasskeyVerify,
} = await import('@/lib/webauthn');
const { db, authenticatorDB, userDB } = await import('@/lib/db');
const { GET: me } = await import('@/app/api/auth/me/route');
const { POST: logout } = await import('@/app/api/auth/logout/route');
const { unlinkSync, rmdirSync } = await import('node:fs');

const origin = 'http://localhost:3000';
const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const jwk = publicKey.export({ format: 'jwk' });
if (!jwk.x || !jwk.y) throw new Error('Test public key coordinates missing');
const coseKey = isoCBOR.encode(new Map<number, number | Uint8Array>([
  [1, 2], [3, -7], [-1, 1],
  [-2, new Uint8Array(Buffer.from(jwk.x, 'base64url'))],
  [-3, new Uint8Array(Buffer.from(jwk.y, 'base64url'))],
]));
const credentialId = randomBytes(32);
const credentialBase = {
  id: credentialId.toString('base64url'),
  rawId: credentialId.toString('base64url'),
  type: 'public-key',
  clientExtensionResults: {},
};
const rpHash = createHash('sha256').update('localhost').digest();

function request(body: unknown, requestOrigin = origin): Request {
  return new Request(`${origin}/api/auth`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: requestOrigin },
    body: JSON.stringify(body),
  });
}

function clientData(challenge: string, type: 'webauthn.create' | 'webauthn.get') {
  return Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
}

function registrationResponse(challenge: string, id = credentialId) {
  const length = Buffer.alloc(2);
  length.writeUInt16BE(id.length);
  const authData = Buffer.concat([
    rpHash, Buffer.from([0x45]), Buffer.alloc(4), Buffer.alloc(16), length,
    id, coseKey,
  ]);
  const attestation = isoCBOR.encode(new Map<string, string | Uint8Array | Map<string, never>>([
    ['fmt', 'none'], ['attStmt', new Map<string, never>()], ['authData', new Uint8Array(authData)],
  ]));
  return {
    ...credentialBase,
    id: id.toString('base64url'),
    rawId: id.toString('base64url'),
    response: {
      clientDataJSON: clientData(challenge, 'webauthn.create').toString('base64url'),
      attestationObject: Buffer.from(attestation).toString('base64url'),
    },
  };
}

function authenticationResponse(challenge: string, counter: number, validSignature = true, id = credentialId) {
  const count = Buffer.alloc(4);
  count.writeUInt32BE(counter);
  const authData = Buffer.concat([rpHash, Buffer.from([0x05]), count]);
  const client = clientData(challenge, 'webauthn.get');
  const signature = sign('sha256', Buffer.concat([
    authData, createHash('sha256').update(client).digest(),
  ]), privateKey);
  if (!validSignature) signature[signature.length - 1] ^= 0xff;
  return {
    ...credentialBase,
    id: id.toString('base64url'),
    rawId: id.toString('base64url'),
    response: {
      clientDataJSON: client.toString('base64url'),
      authenticatorData: authData.toString('base64url'),
      signature: signature.toString('base64url'),
    },
  };
}

async function register(username = 'passkey-user') {
  const options = await registerOptions(request({ username }));
  expect(options.status).toBe(200);
  const { challenge } = await options.json();
  const result = await registerVerify(request({ username, response: registrationResponse(challenge) }));
  expect(result.status).toBe(200);
}

beforeEach(() => {
  vi.stubEnv('JWT_SECRET', 'test-only-secret-with-at-least-32-bytes');
  vi.stubEnv('RP_ORIGIN', origin);
  vi.stubEnv('RP_ID', 'localhost');
  state.jar.clear();
  db.prepare('DELETE FROM auth_challenges').run();
  db.prepare('DELETE FROM users').run();
});

afterAll(() => {
  db.close();
  process.chdir(state.previous);
  unlinkSync(`${state.directory}/todos.db`);
  rmdirSync(state.directory);
});

describe('real WebAuthn verification and sessions', () => {
  it('registers, persists a passkey, logs out, and logs in using a signed assertion', async () => {
    await register();
    expect(await (await me()).json()).toMatchObject({ username: 'passkey-user' });
    expect(state.jar.get('session')).toBeTruthy();
    await logout();
    expect((await me()).status).toBe(401);
    const options = await loginOptions(request({ username: 'passkey-user' }));
    const { challenge } = await options.json();
    const result = await loginVerify(request({
      username: 'passkey-user', response: authenticationResponse(challenge, 1),
    }));
    expect(result.status).toBe(200);
    expect((await me()).status).toBe(200);
    expect(authenticatorDB.findByCredentialId(credentialBase.id)?.counter).toBe(1);
    expect((await loginVerify(request({
      username: 'passkey-user', response: authenticationResponse(challenge, 2),
    }))).status).toBe(401);
  });

  it('rejects invalid signatures and counter regressions without creating sessions', async () => {
    await register();
    await logout();
    let options = await loginOptions(request({ username: 'passkey-user' }));
    let challenge = (await options.json()).challenge;
    expect((await loginVerify(request({
      username: 'passkey-user', response: authenticationResponse(challenge, 1, false),
    }))).status).toBe(401);
    expect((await me()).status).toBe(401);
    authenticatorDB.updateCounter(authenticatorDB.findByCredentialId(credentialBase.id)!.id, 3);
    options = await loginOptions(request({ username: 'passkey-user' }));
    challenge = (await options.json()).challenge;
    expect((await loginVerify(request({
      username: 'passkey-user', response: authenticationResponse(challenge, 2),
    }))).status).toBe(401);
    expect(authenticatorDB.findByCredentialId(credentialBase.id)?.counter).toBe(3);
  });

  it('binds challenges to browser and username and rejects invalid origins', async () => {
    expect((await registerOptions(request({ username: 'test' }, 'https://other.example'))).status).toBe(403);
    const options = await registerOptions(request({ username: 'intended' }));
    const { challenge } = await options.json();
    const cookie = state.jar.get('webauthn-challenge')!;
    state.jar.clear();
    expect((await registerVerify(request({
      username: 'intended', response: registrationResponse(challenge),
    }))).status).toBe(401);
    state.jar.set('webauthn-challenge', cookie);
    expect((await registerVerify(request({
      username: 'different', response: registrationResponse(challenge),
    }))).status).toBe(401);
    expect(userDB.findByUsername('different')).toBeNull();
    expect(userDB.findByUsername('intended')).toBeNull();
  });

  it('stores browser-bound challenges in SQLite and consumes expired challenges', async () => {
    const options = await registerOptions(request({ username: 'expiry-user' }));
    const { challenge } = await options.json();
    const id = state.jar.get('webauthn-challenge');
    expect(db.prepare('SELECT username FROM auth_challenges WHERE id = ?').get(id))
      .toEqual({ username: 'expiry-user' });
    db.prepare('UPDATE auth_challenges SET expires = ? WHERE id = ?').run(Date.now() - 1, id);
    expect((await registerVerify(request({
      username: 'expiry-user', response: registrationResponse(challenge),
    }))).status).toBe(401);
    expect(db.prepare('SELECT id FROM auth_challenges WHERE id = ?').get(id)).toBeUndefined();
  });

  it('requires an existing session to add a passkey and binds it to the account', async () => {
    expect((await addPasskeyOptions(request({}))).status).toBe(401);
    expect((await addPasskeyVerify(request({}))).status).toBe(401);
    await register();
    const user = userDB.findByUsername('passkey-user')!;
    const secondId = randomBytes(32);
    const options = await addPasskeyOptions(request({}));
    expect(options.status).toBe(200);
    const body = await options.json();
    expect(body.excludeCredentials).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: credentialBase.id }),
    ]));
    const response = registrationResponse(body.challenge, secondId);
    expect((await addPasskeyVerify(request({ response }))).status).toBe(200);
    expect(authenticatorDB.findByCredentialId(secondId.toString('base64url'))?.user_id).toBe(user.id);
    expect((await addPasskeyVerify(request({ response }))).status).toBe(401);
    expect(authenticatorDB.findByUserId(user.id)).toHaveLength(2);
    await logout();
    const login = await loginOptions(request({ username: user.username }));
    const loginChallenge = (await login.json()).challenge;
    expect((await loginVerify(request({
      username: user.username, response: authenticationResponse(loginChallenge, 1, true, secondId),
    }))).status).toBe(200);
  });

  it('does not add a credential when the session changes between options and verification', async () => {
    await register();
    const owner = userDB.findByUsername('passkey-user')!;
    const other = userDB.create('other-user');
    const options = await addPasskeyOptions(request({}));
    const { challenge } = await options.json();
    const { createSession } = await import('@/lib/auth');
    await createSession(other);
    const id = randomBytes(32);
    expect((await addPasskeyVerify(request({ response: registrationResponse(challenge, id) }))).status).toBe(401);
    expect(authenticatorDB.findByCredentialId(id.toString('base64url'))).toBeNull();
    expect(authenticatorDB.findByUserId(owner.id)).toHaveLength(1);
  });
});
